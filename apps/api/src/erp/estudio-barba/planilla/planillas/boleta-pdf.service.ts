import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { PdfService, pdfLayoutBordeado } from '@app/common';

/**
 * Colores del set fijo `--reporte-*` de `styles.scss`. Espejados a mano acá porque un
 * PDF no lee CSS. NUNCA se usan `--erp-primary`/`--erp-sidebar-*`: esos cambian con el
 * tema que el usuario eligió y dos personas se bajarían la misma boleta con colores
 * distintos (regla de "Colores de reportes" en CLAUDE.md).
 */
const COLOR = {
  cabecera: '#0C1A2E',
  cabeceraTexto: '#FFFFFF',
  borde: '#CBD5E1',
  filaAlterna: '#F8FAFC',
  ingreso: '#15803D',
  descuento: '#DC2626',
  neutro: '#64748B',
  texto: '#111111',
  textoSuave: '#333333',
} as const;

const MESES = [
  '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Setiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

/** Los DECIMAL de MySQL llegan como string por el driver: sin `Number()` se concatenan. */
const num = (v: any): number => Number(v ?? 0);

/** Formato peruano, siempre con dos decimales. `toFixed` sobre el número ya convertido. */
const money = (v: any): string =>
  num(v).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fecha = (v: any): string => (v ? new Date(v).toLocaleDateString('es-PE') : '—');

/**
 * Boleta de pago en PDF.
 *
 * Se GENERA al vuelo, no se guarda ningún archivo: `planilla_detalle` +
 * `planilla_detalle_concepto` ya guardan el snapshot completo del cálculo (sueldo,
 * régimen, AFP y la tasa exacta que se aplicó), así que la boleta es reproducible
 * idéntica años después. Guardar además el PDF sería una segunda copia del mismo dato,
 * con la posibilidad de que quede desincronizada.
 *
 * Vive en `planillas/` y no en `cliente/` porque la usan los DOS lados: la intranet
 * (el estudio imprime la boleta) y el portal cliente (la empresa se la descarga). El
 * módulo se exporta desde `PlanillasModule` y el portal lo inyecta declarando la
 * dependencia, como manda CLAUDE.md — no se copia el archivo.
 *
 * ⚠️ pdfmake 0.3: NO se toca `setFonts()` ni la política de acceso acá. El registro de
 * fuentes vive solo en `pdf-fuentes.ts` y `PdfService` ya fija `defaultStyle.font`; un
 * service que registre fuentes por su cuenta deja al resto de los reportes sin ellas.
 */
@Injectable()
export class BoletaPdfService {
  constructor(private readonly pdfService: PdfService) {}

  /**
   * `boleta` es exactamente lo que devuelve `PlanillasService.findBoleta()`:
   * `{ planilla, detalle, ingresos, descuentos, aportes }`.
   *
   * No consulta la base: recibe los datos ya armados. Así el llamador decide con qué
   * alcance los buscó — el portal cliente los pide acotados por su empresa y la
   * intranet sin acotar — y este service no necesita saber quién pregunta.
   */
  async generar(boleta: any, res: Response) {
    const { planilla, detalle, ingresos, descuentos, aportes } = boleta;

    const totalIngresos = num(detalle.total_ingresos);
    const totalDescuentos = num(detalle.total_descuentos);
    const totalAportes = num(detalle.total_aportes_empleador);
    const adelanto = num(detalle.adelanto_quincena);
    const neto = num(detalle.neto_pagar);

    const periodo = `${MESES[Number(planilla.mes)] ?? planilla.mes} ${planilla.anio}`;
    const nombreArchivo = `boleta-${String(detalle.numero_documento || '').trim()}-${planilla.anio}-${String(planilla.mes).padStart(2, '0')}`;

    const doc: TDocumentDefinitions = {
      pageSize: 'A4',
      pageMargins: [32, 32, 32, 44],
      content: [
        ...this.cabecera(planilla, periodo),
        this.datosTrabajador(detalle),
        this.diasYHoras(detalle),

        ...this.bloqueConceptos('INGRESOS', ingresos, totalIngresos, COLOR.ingreso),
        ...this.bloqueConceptos('DESCUENTOS', descuentos, totalDescuentos, COLOR.descuento),

        this.neto(totalIngresos, totalDescuentos, adelanto, neto),

        // Los aportes del empleador NO se descuentan al trabajador. Van en la boleta
        // porque el PLAME los declara y el trabajador tiene derecho a ver que su
        // EsSalud se aportó, pero separados y rotulados para que nadie los lea como
        // parte de su descuento.
        ...this.bloqueConceptos(
          'APORTES DEL EMPLEADOR (no se descuentan al trabajador)',
          aportes,
          totalAportes,
          COLOR.neutro,
        ),

        this.firmas(),
      ],
      // Nota al pie: SOLO lo que el lector no puede deducir mirando el cuadro. Qué es
      // un descuento ya lo sabe; de qué periodo salió el cálculo y con qué RMV/UIT, no.
      footer: (paginaActual: number, totalPaginas: number) => ({
        margin: [32, 8, 32, 0],
        columns: [
          {
            text: [
              `Periodo ${periodo}`,
              ` · Planilla ${planilla.tipo}`,
              planilla.snap_rmv ? ` · RMV S/ ${money(planilla.snap_rmv)}` : '',
              planilla.snap_uit ? ` · UIT S/ ${money(planilla.snap_uit)}` : '',
              ` · Jornada ${money(planilla.snap_horas_jornada)} h`,
            ].join(''),
            fontSize: 7,
            color: COLOR.textoSuave,
          },
          { text: `${paginaActual} / ${totalPaginas}`, fontSize: 7, alignment: 'right', color: COLOR.textoSuave },
        ],
      }),
      defaultStyle: { font: 'Helvetica', fontSize: 9, color: COLOR.texto },
    };

    await this.pdfService.generarPdf(doc, nombreArchivo, res);
  }

  // ==========================================================================
  // Bloques
  // ==========================================================================

  private cabecera(planilla: any, periodo: string): Content[] {
    return [
      {
        columns: [
          {
            width: '*',
            stack: [
              { text: String(planilla.razon_social || '').toUpperCase(), fontSize: 13, bold: true },
              { text: `RUC ${planilla.ruc}`, fontSize: 9, color: COLOR.textoSuave, margin: [0, 2, 0, 0] },
            ],
          },
          {
            width: 'auto',
            alignment: 'right',
            stack: [
              { text: 'BOLETA DE PAGO', fontSize: 11, bold: true, color: COLOR.cabecera },
              { text: periodo, fontSize: 10, margin: [0, 2, 0, 0] },
              // El estado importa: una planilla en BORRADOR puede recalcularse y los
              // montos cambiarían. Imprimirlo evita que alguien archive como
              // definitiva una boleta que todavía no lo es.
              { text: `Planilla ${planilla.estado}`, fontSize: 8, color: COLOR.textoSuave, margin: [0, 2, 0, 0] },
            ],
          },
        ],
      },
      {
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 531, y2: 0, lineWidth: 1.5, lineColor: COLOR.cabecera }],
        margin: [0, 10, 0, 12],
      },
    ];
  }

  private datosTrabajador(d: any): Content {
    const filas: Array<[string, string]> = [
      ['Trabajador', String(d.nombre_trabajador || '')],
      ['Documento', String(d.numero_documento || '')],
      ['Cargo', String(d.cargo || '—')],
      ['Fecha de ingreso', fecha(d.fecha_ingreso)],
      ['Régimen laboral', String(d.nombre_regimen || '—')],
      [
        'Régimen pensionario',
        d.snap_regimen_pensionario === 'AFP'
          ? `AFP ${d.nombre_afp ?? ''} (${d.snap_tipo_comision_afp ?? '—'})`.trim()
          : String(d.snap_regimen_pensionario || '—'),
      ],
    ];

    return {
      table: {
        widths: ['auto', '*', 'auto', '*'],
        body: [
          [this.etiqueta(filas[0][0]), this.valor(filas[0][1]), this.etiqueta(filas[1][0]), this.valor(filas[1][1])],
          [this.etiqueta(filas[2][0]), this.valor(filas[2][1]), this.etiqueta(filas[3][0]), this.valor(filas[3][1])],
          [this.etiqueta(filas[4][0]), this.valor(filas[4][1]), this.etiqueta(filas[5][0]), this.valor(filas[5][1])],
        ],
      },
      layout: pdfLayoutBordeado(COLOR.borde),
      margin: [0, 0, 0, 12],
    };
  }

  /**
   * Días y horas del periodo. Solo se imprimen los que tienen valor: una boleta con
   * seis columnas en cero por trabajador con asistencia perfecta es ruido, y esconde
   * las que sí importan cuando aparecen.
   */
  private diasYHoras(d: any): Content {
    const items: Array<{ label: string; valor: string }> = [
      { label: 'Días laborados', valor: money(d.dias_laborados) },
    ];
    const opcionales: Array<[string, any]> = [
      ['Días no laborados', d.dias_no_laborados],
      ['Días subsidiados', d.dias_subsidiados],
      ['Faltas', d.dias_faltas],
      ['Vacaciones', d.dias_vacaciones],
      ['H. extras 25%', d.horas_extras_25],
      ['H. extras 35%', d.horas_extras_35],
    ];
    for (const [label, valor] of opcionales) {
      if (num(valor) > 0) items.push({ label, valor: money(valor) });
    }

    return {
      table: {
        widths: items.map(() => '*'),
        body: [
          items.map((i) => ({
            stack: [
              { text: i.label.toUpperCase(), fontSize: 6.5, bold: true, color: COLOR.textoSuave },
              { text: i.valor, fontSize: 10, bold: true, margin: [0, 2, 0, 0] },
            ],
          })),
        ],
      },
      layout: pdfLayoutBordeado(COLOR.borde),
      margin: [0, 0, 0, 12],
    };
  }

  /**
   * Un cuadro de conceptos (ingresos, descuentos o aportes) con su total.
   *
   * Devuelve `[]` cuando no hay filas: imprimir un cuadro vacío con el título y un
   * total en cero hace pensar que se perdió información. Si el trabajador no tuvo
   * descuentos, el cuadro simplemente no aparece.
   */
  private bloqueConceptos(titulo: string, filas: any[], total: number, colorTotal: string): Content[] {
    if (!filas || filas.length === 0) return [];

    const body: any[] = [
      [
        { text: 'CÓD.', bold: true, fontSize: 7.5, color: COLOR.cabeceraTexto, fillColor: COLOR.cabecera },
        { text: 'CONCEPTO', bold: true, fontSize: 7.5, color: COLOR.cabeceraTexto, fillColor: COLOR.cabecera },
        { text: 'CANT.', bold: true, fontSize: 7.5, alignment: 'right', color: COLOR.cabeceraTexto, fillColor: COLOR.cabecera },
        { text: 'BASE', bold: true, fontSize: 7.5, alignment: 'right', color: COLOR.cabeceraTexto, fillColor: COLOR.cabecera },
        { text: '%', bold: true, fontSize: 7.5, alignment: 'right', color: COLOR.cabeceraTexto, fillColor: COLOR.cabecera },
        { text: 'IMPORTE S/', bold: true, fontSize: 7.5, alignment: 'right', color: COLOR.cabeceraTexto, fillColor: COLOR.cabecera },
      ],
      ...filas.map((c: any, i: number) => {
        const fondo = i % 2 === 1 ? COLOR.filaAlterna : undefined;
        return [
          { text: c.codigo_plame ?? '', fontSize: 8, fillColor: fondo },
          { text: c.nombre_concepto ?? '', fontSize: 8, fillColor: fondo },
          // Un `0` en cantidad/base/porcentaje casi nunca significa cero: significa
          // que ese concepto no se calcula así. Se imprime vacío, no un cero que
          // invita a sumarlo o promediarlo.
          { text: num(c.cantidad) ? money(c.cantidad) : '', fontSize: 8, alignment: 'right', fillColor: fondo },
          { text: num(c.base_calculo) ? money(c.base_calculo) : '', fontSize: 8, alignment: 'right', fillColor: fondo },
          { text: num(c.porcentaje_aplicado) ? `${num(c.porcentaje_aplicado).toFixed(2)}%` : '', fontSize: 8, alignment: 'right', fillColor: fondo },
          { text: money(c.monto), fontSize: 8, alignment: 'right', fillColor: fondo },
        ];
      }),
      [
        { text: '', border: [false, false, false, false] },
        { text: `TOTAL ${titulo.split(' (')[0]}`, bold: true, fontSize: 8.5, colSpan: 4, alignment: 'right' },
        {}, {}, {},
        { text: money(total), bold: true, fontSize: 9.5, alignment: 'right', color: colorTotal },
      ],
    ];

    return [
      { text: titulo, fontSize: 8.5, bold: true, margin: [0, 0, 0, 4] },
      {
        table: { headerRows: 1, widths: [30, '*', 42, 58, 34, 62], body },
        layout: pdfLayoutBordeado(COLOR.borde),
        margin: [0, 0, 0, 12],
      },
    ];
  }

  /**
   * El neto. Es el número por el que se abre la boleta, así que va aparte y grande.
   *
   * El adelanto de quincena se muestra como línea propia y no mezclado con los
   * descuentos: no es un descuento de ley, es plata que el trabajador ya cobró. Solo
   * aparece si hubo.
   */
  private neto(totalIngresos: number, totalDescuentos: number, adelanto: number, neto: number): Content {
    const filas: any[] = [
      this.filaTotal('Total ingresos', money(totalIngresos)),
      this.filaTotal('Total descuentos', `- ${money(totalDescuentos)}`),
    ];
    if (adelanto > 0) filas.push(this.filaTotal('Adelanto de quincena', `- ${money(adelanto)}`));
    filas.push([
      {
        columns: [
          { text: 'NETO A PAGAR', fontSize: 10, bold: true },
          { text: `S/ ${money(neto)}`, fontSize: 15, bold: true, alignment: 'right' },
        ],
        border: [false, false, false, false],
      },
    ]);

    return {
      columns: [
        { width: '*', text: '' },
        {
          width: 250,
          table: { widths: ['*'], body: filas },
          layout: pdfLayoutBordeado(COLOR.borde),
        },
      ],
      margin: [0, 0, 0, 18],
    };
  }

  private filaTotal(label: string, monto: string) {
    return [
      {
        columns: [
          { text: label, fontSize: 8.5, color: COLOR.textoSuave },
          { text: monto, fontSize: 9, alignment: 'right' },
        ],
        border: [false, false, false, false] as [boolean, boolean, boolean, boolean],
      },
    ];
  }

  private firmas(): Content {
    return {
      columns: [
        {
          width: '*',
          stack: [
            { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 190, y2: 0, lineWidth: 0.8, lineColor: COLOR.neutro }] },
            { text: 'Empleador', fontSize: 8, color: COLOR.textoSuave, margin: [0, 4, 0, 0] },
          ],
        },
        { width: 40, text: '' },
        {
          width: '*',
          stack: [
            { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 190, y2: 0, lineWidth: 0.8, lineColor: COLOR.neutro }] },
            { text: 'Trabajador', fontSize: 8, color: COLOR.textoSuave, margin: [0, 4, 0, 0] },
          ],
        },
      ],
      margin: [0, 24, 0, 0],
    };
  }

  private etiqueta(texto: string) {
    return { text: texto.toUpperCase(), fontSize: 6.5, bold: true, color: COLOR.textoSuave };
  }

  private valor(texto: string) {
    return { text: texto, fontSize: 9, bold: true };
  }
}

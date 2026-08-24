import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { AuditoriaService, PdfService, pdfLayoutBordeado } from '@app/common';
import {
  MarcarDeclaracionDto,
  UpsertCronogramaDto,
  RegistrarSaldoFavorDto,
  RegistrarCortePreliminarDto,
} from './dto/declaracion.dto';

const TIPO_LABEL: Record<string, string> = {
  IGV_RENTA: 'IGV - Renta (621)',
  PLANILLA: 'Planilla (PLAME)',
  RCE_RVIE_SIRE: 'Registro Compras/Ventas (SIRE)',
  AFP_NET: 'AFP Net',
};

@Injectable()
export class DeclaracionesService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private pdfService: PdfService,
  ) {}

  // ---------- Semáforo (vista principal del módulo) ----------
  // `tipos`, si viene, filtra las filas por tipo_obligacion — así el mismo SP alimenta
  // tanto la vista tributaria (IGV_RENTA/RCE_RVIE_SIRE) como la laboral (PLANILLA).
  async control(anio: number, mes: number, tipos?: string[]) {
    const [data] = await this.dataSource.query(`CALL declaracion_control(?, ?)`, [anio, mes]);
    const filtrado = tipos ? data.filter((fila: any) => tipos.includes(fila.tipo_obligacion)) : data;
    return { success: true, data: filtrado };
  }

  // ---------- Reporte PDF del semáforo ----------
  // Reutiliza `control()` y aplica los mismos filtros que el usuario tiene activos en pantalla
  // (id_empresa/alerta_declaracion) — el PDF exportado siempre coincide con lo que se ve en la tabla,
  // nunca con el dataset completo del periodo sin filtrar.
  async controlPdf(
    anio: number,
    mes: number,
    tipos: string[] | undefined,
    filtros: { idEmpresa?: number; alertaDeclaracion?: string },
    tituloArea: string,
    res: Response,
  ) {
    const { data } = await this.control(anio, mes, tipos);
    const filas = data.filter((fila: any) => {
      if (filtros.idEmpresa && Number(fila.id_empresa) !== filtros.idEmpresa) return false;
      if (filtros.alertaDeclaracion && fila.alerta_declaracion !== filtros.alertaDeclaracion) return false;
      return true;
    });

    const mesLabel = String(mes).padStart(2, '0');
    const PAGO_LABEL: Record<string, string> = {
      PAGADO: 'Pagado',
      PENDIENTE_PAGO: 'Sin pagar',
      VENCIDO_SIN_PAGAR: 'Vencido sin pagar',
      ERROR_VERIFICACION: 'Error de verificación',
      PENDIENTE_VERIFICAR: 'Sin verificar',
    };
    const body = [
      [
        { text: 'EMPRESA', bold: true, fontSize: 9 },
        { text: 'OBLIGACIÓN', bold: true, fontSize: 9 },
        { text: 'VENCE', bold: true, fontSize: 9 },
        { text: 'ESTADO', bold: true, fontSize: 9 },
        { text: 'DECLARADO', bold: true, fontSize: 9 },
        { text: 'PAGO', bold: true, fontSize: 9 },
      ],
      ...filas.map((fila: any) => [
        { text: fila.razon_social ?? '', fontSize: 8.5 },
        { text: TIPO_LABEL[fila.tipo_obligacion] ?? fila.tipo_obligacion, fontSize: 8.5 },
        { text: fila.fecha_limite ? new Date(fila.fecha_limite).toLocaleDateString('es-PE') : '', fontSize: 8.5 },
        { text: fila.alerta_declaracion ?? '', fontSize: 8.5 },
        { text: fila.fecha_declaracion ? new Date(fila.fecha_declaracion).toLocaleDateString('es-PE') : '—', fontSize: 8.5 },
        { text: PAGO_LABEL[fila.alerta_pago] ?? fila.alerta_pago ?? '—', fontSize: 8.5 },
      ]),
    ];

    await this.pdfService.generarPdf(
      {
        pageMargins: [30, 30, 30, 30],
        content: [
          { text: `Semáforo de vencimientos — ${tituloArea}`, fontSize: 14, bold: true },
          { text: `Periodo ${mesLabel}/${anio}`, fontSize: 10, color: '#333333', margin: [0, 2, 0, 14] },
          {
            table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'], body },
            layout: pdfLayoutBordeado('#dddddd'),
          },
        ],
        defaultStyle: { font: 'Helvetica' },
      },
      `control-${tituloArea.toLowerCase()}-${anio}-${mesLabel}`,
      res,
    );
  }

  // ---------- Declaración manual (Fase 1) ----------
  async marcarManual(dto: MarcarDeclaracionDto, userId: number) {
    const [oldValues] = await this.dataSource.query(
      `SELECT id_declaracion, estado_verificacion, fecha_declaracion, constancia_archivo, fuente
       FROM declaracion WHERE id_empresa = ? AND periodo_anio = ? AND periodo_mes = ? AND tipo_obligacion = ?`,
      [dto.id_empresa, dto.periodo_anio, dto.periodo_mes, dto.tipo_obligacion],
    );

    // mysql2 no convierte bien un string ISO ("...T00:00:00.000Z") como parámetro
    // DATETIME de un stored procedure — hay que mandar un objeto Date real.
    // Encontrado probando el endpoint en vivo, no es teórico.
    await this.dataSource.query(
      `CALL declaracion_marcar_manual(?, ?, ?, ?, ?, ?, ?)`,
      [dto.id_empresa, dto.periodo_anio, dto.periodo_mes, dto.tipo_obligacion, new Date(dto.fecha_declaracion), dto.constancia_archivo ?? null, userId],
    );

    const [nueva] = await this.dataSource.query(
      `SELECT id_declaracion FROM declaracion WHERE id_empresa = ? AND periodo_anio = ? AND periodo_mes = ? AND tipo_obligacion = ?`,
      [dto.id_empresa, dto.periodo_anio, dto.periodo_mes, dto.tipo_obligacion],
    );
    await this.auditoriaService.registrar('declaracion', nueva.id_declaracion, oldValues ? 'ACTUALIZAR' : 'CREAR', userId, oldValues ?? null, dto);
    return { success: true, message: 'Declaración registrada' };
  }

  // ---------- Cronograma ----------
  async upsertCronograma(dto: UpsertCronogramaDto, userId: number) {
    const [oldValues] = await this.dataSource.query(
      `SELECT id_cronograma, fecha_limite FROM cronograma_vencimiento
       WHERE anio = ? AND mes = ? AND digito_ruc = ? AND tipo_obligacion = ?`,
      [dto.anio, dto.mes, dto.digito_ruc, dto.tipo_obligacion],
    );

    await this.dataSource.query(
      `CALL cronograma_upsert(?, ?, ?, ?, ?)`,
      [dto.anio, dto.mes, dto.digito_ruc, dto.tipo_obligacion, dto.fecha_limite],
    );

    const [nuevo] = await this.dataSource.query(
      `SELECT id_cronograma FROM cronograma_vencimiento WHERE anio = ? AND mes = ? AND digito_ruc = ? AND tipo_obligacion = ?`,
      [dto.anio, dto.mes, dto.digito_ruc, dto.tipo_obligacion],
    );
    await this.auditoriaService.registrar('cronograma_vencimiento', nuevo.id_cronograma, oldValues ? 'ACTUALIZAR' : 'CREAR', userId, oldValues ?? null, dto);
    return { success: true, message: 'Cronograma actualizado' };
  }

  async listarCronograma(anio?: number, mes?: number) {
    const [data] = await this.dataSource.query(`CALL cronograma_listar(?, ?)`, [anio ?? null, mes ?? null]);
    return { success: true, data };
  }

  // ---------- Saldo a favor ----------
  async registrarSaldoFavor(dto: RegistrarSaldoFavorDto, userId: number) {
    const [oldValues] = await this.dataSource.query(
      `SELECT id_saldo, monto FROM saldo_favor
       WHERE id_empresa = ? AND periodo_anio = ? AND periodo_mes = ? AND tipo_impuesto = ? AND fuente = ?`,
      [dto.id_empresa, dto.periodo_anio, dto.periodo_mes, dto.tipo_impuesto, dto.fuente],
    );

    await this.dataSource.query(
      `CALL saldo_favor_registrar(?, ?, ?, ?, ?, ?)`,
      [dto.id_empresa, dto.periodo_anio, dto.periodo_mes, dto.tipo_impuesto, dto.monto, dto.fuente],
    );

    const [nuevo] = await this.dataSource.query(
      `SELECT id_saldo FROM saldo_favor WHERE id_empresa = ? AND periodo_anio = ? AND periodo_mes = ? AND tipo_impuesto = ? AND fuente = ?`,
      [dto.id_empresa, dto.periodo_anio, dto.periodo_mes, dto.tipo_impuesto, dto.fuente],
    );
    await this.auditoriaService.registrar('saldo_favor', nuevo.id_saldo, oldValues ? 'ACTUALIZAR' : 'CREAR', userId, oldValues ?? null, dto);
    return { success: true, message: 'Saldo a favor registrado' };
  }

  async saldoFavorPorEmpresa(idEmpresa: number) {
    const [data] = await this.dataSource.query(`CALL saldo_favor_por_empresa(?)`, [idEmpresa]);
    return { success: true, data };
  }

  // ---------- Crédito fiscal SIRE (Fase 2, Camino A: API oficial) ----------
  async creditoFiscalSirePorEmpresa(idEmpresa: number) {
    const [data] = await this.dataSource.query(`CALL credito_fiscal_sire_por_empresa(?)`, [idEmpresa]);
    return { success: true, data };
  }

  // ---------- Corte preliminar ----------
  async registrarCortePreliminar(dto: RegistrarCortePreliminarDto, userId: number) {
    const [oldValues] = await this.dataSource.query(
      `SELECT id_corte, total_compras, total_ventas, compras_no_grabadas, resultado_igv FROM corte_preliminar
       WHERE id_empresa = ? AND periodo_anio = ? AND periodo_mes = ?`,
      [dto.id_empresa, dto.periodo_anio, dto.periodo_mes],
    );

    await this.dataSource.query(
      `CALL corte_preliminar_registrar(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dto.id_empresa, dto.periodo_anio, dto.periodo_mes,
        dto.total_compras, dto.total_ventas, dto.compras_no_grabadas ?? 0, dto.resultado_igv,
        userId,
      ],
    );

    const [nuevo] = await this.dataSource.query(
      `SELECT id_corte FROM corte_preliminar WHERE id_empresa = ? AND periodo_anio = ? AND periodo_mes = ?`,
      [dto.id_empresa, dto.periodo_anio, dto.periodo_mes],
    );
    await this.auditoriaService.registrar('corte_preliminar', nuevo.id_corte, oldValues ? 'ACTUALIZAR' : 'CREAR', userId, oldValues ?? null, dto);
    return { success: true, message: 'Corte preliminar registrado' };
  }
}

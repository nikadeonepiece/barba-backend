import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import * as ExcelJS from 'exceljs';
import { ConfirmarImportacionDto } from './dto/importacion.dto';
import { aFechaISO } from '../fecha.util';

/**
 * Importación masiva de trabajadores desde el Excel que el estudio ya usa.
 *
 * POR QUÉ ESTE CAMINO Y NO SCRAPEAR SUNAT:
 * el T-Registro tiene el padrón y hasta la remuneración básica INICIAL (Estructura 5,
 * campo 16), pero no los aumentos posteriores — el sueldo vigente vive en el PLAME,
 * declaración por declaración. El Excel del estudio, en cambio, tiene el sueldo de hoy
 * porque es con el que corren la planilla cada mes: si estuviera mal, les saldría mal
 * el cálculo. Además no depende del WAF de SUNAT ni de que no cambien el portal.
 *
 * FLUJO EN DOS PASOS, y el motivo:
 *   1. `analizar`  — sube el archivo, devuelve columnas y filas crudas.
 *   2. `confirmar` — recibe el mapeo que hizo el usuario y crea los trabajadores.
 *
 * Se hace así porque cada empresa arma su Excel distinto: una pone "DNI", otra
 * "N° Documento", otra "Nro Doc". Adivinar el formato garantiza que funcione con un
 * archivo y falle con el siguiente. Con el mapeo explícito, el usuario dice qué es
 * cada columna una vez y el importador sirve para cualquier planilla.
 *
 * El archivo NO se guarda: se parsea en memoria y las filas viajan al frontend. Un
 * padrón son cientos de filas, no millones, y así no quedan archivos con datos
 * personales de terceros acumulándose en disco.
 */

/** Campos que el importador sabe llenar. `requerido` marca los que no pueden faltar. */
export const CAMPOS_IMPORTABLES = [
  { campo: 'numero_documento', etiqueta: 'Número de documento', requerido: true, tipo: 'texto' },
  { campo: 'apellido_paterno', etiqueta: 'Apellido paterno', requerido: true, tipo: 'texto' },
  { campo: 'apellido_materno', etiqueta: 'Apellido materno', requerido: false, tipo: 'texto' },
  { campo: 'nombres', etiqueta: 'Nombres', requerido: true, tipo: 'texto' },
  { campo: 'sueldo_basico', etiqueta: 'Sueldo básico', requerido: true, tipo: 'numero' },
  { campo: 'fecha_ingreso', etiqueta: 'Fecha de ingreso', requerido: true, tipo: 'fecha' },
  { campo: 'nombre_completo', etiqueta: 'Nombre completo (si no vienen separados)', requerido: false, tipo: 'texto' },
  { campo: 'cargo', etiqueta: 'Cargo', requerido: false, tipo: 'texto' },
  { campo: 'area', etiqueta: 'Área', requerido: false, tipo: 'texto' },
  { campo: 'fecha_nacimiento', etiqueta: 'Fecha de nacimiento', requerido: false, tipo: 'fecha' },
  { campo: 'sexo', etiqueta: 'Sexo (M/F)', requerido: false, tipo: 'texto' },
  { campo: 'regimen_pensionario', etiqueta: 'Régimen pensionario (ONP/AFP)', requerido: false, tipo: 'texto' },
  { campo: 'nombre_afp', etiqueta: 'AFP', requerido: false, tipo: 'texto' },
  { campo: 'cuspp', etiqueta: 'CUSPP', requerido: false, tipo: 'texto' },
  { campo: 'tipo_comision_afp', etiqueta: 'Tipo de comisión AFP (FLUJO/MIXTA)', requerido: false, tipo: 'texto' },
  { campo: 'tiene_hijos_menores', etiqueta: 'Asignación familiar (SÍ/NO)', requerido: false, tipo: 'booleano' },
  { campo: 'cci_sueldo', etiqueta: 'CCI de haberes', requerido: false, tipo: 'texto' },
  { campo: 'email', etiqueta: 'Correo', requerido: false, tipo: 'texto' },
  { campo: 'telefono', etiqueta: 'Teléfono', requerido: false, tipo: 'texto' },
];

const LIMITE_FILAS = 5000;

const texto = (v: any): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t: any) => t.text).join('');
    if (v.text) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v instanceof Date) return aFechaISO(v) ?? '';
    if (v.hyperlink && v.text) return String(v.text);
  }
  return String(v);
};

const limpiar = (v: any): string => texto(v).replace(/\s+/g, ' ').trim();

@Injectable()
export class ImportacionTrabajadoresService {
  private readonly logger = new Logger(ImportacionTrabajadoresService.name);

  constructor(@InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource) {}

  camposImportables() {
    return CAMPOS_IMPORTABLES;
  }

  /**
   * Paso 1: lee el archivo y devuelve qué hay dentro, sin interpretar nada.
   *
   * También propone un mapeo automático por nombre de columna, pero solo como
   * sugerencia: el usuario la confirma o la corrige. Una coincidencia por nombre que
   * se aplique sola es justo lo que mete el sueldo en la columna del teléfono.
   */
  async analizar(buffer: Buffer, nombreHoja?: string) {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as any);
    } catch {
      throw new BadRequestException('No se pudo leer el archivo. ¿Es un .xlsx válido? Los .xls antiguos no sirven: ábrelo en Excel y guárdalo como .xlsx.');
    }

    const hojas = workbook.worksheets.map((w) => w.name);
    if (!hojas.length) throw new BadRequestException('El archivo no tiene ninguna hoja');

    const hoja = nombreHoja ? workbook.getWorksheet(nombreHoja) : workbook.worksheets[0];
    if (!hoja) throw new BadRequestException(`No existe la hoja "${nombreHoja}"`);

    // La fila de encabezados no siempre es la primera: los Excel de planilla suelen
    // tener título, logo y filas en blanco arriba. Se toma la primera fila con 3 o más
    // celdas con texto.
    let filaEncabezado = 0;
    let encabezados: string[] = [];

    for (let n = 1; n <= Math.min(hoja.rowCount, 30); n++) {
      const fila = hoja.getRow(n);
      const celdas: string[] = [];
      fila.eachCell({ includeEmpty: true }, (c) => celdas.push(limpiar(c.value)));
      if (celdas.filter((c) => c.length > 0).length >= 3) {
        filaEncabezado = n;
        encabezados = celdas;
        break;
      }
    }

    if (!filaEncabezado) {
      throw new BadRequestException('No encontré una fila de encabezados en las primeras 30 filas de la hoja');
    }

    const columnas = encabezados
      .map((nombre, i) => ({ indice: i + 1, nombre }))
      .filter((c) => c.nombre.length > 0);

    const filas: any[] = [];
    for (let n = filaEncabezado + 1; n <= hoja.rowCount && filas.length < LIMITE_FILAS; n++) {
      const fila = hoja.getRow(n);
      const valores: Record<number, string> = {};
      let tieneAlgo = false;
      for (const col of columnas) {
        const v = limpiar(fila.getCell(col.indice).value);
        valores[col.indice] = v;
        if (v) tieneAlgo = true;
      }
      if (tieneAlgo) filas.push({ fila: n, valores });
    }

    if (!filas.length) throw new BadRequestException('La hoja no tiene filas de datos debajo de los encabezados');

    return {
      hojas,
      hoja_leida: hoja.name,
      fila_encabezado: filaEncabezado,
      columnas,
      total_filas: filas.length,
      mapeo_sugerido: this.sugerirMapeo(columnas),
      filas,
    };
  }

  /** Sugerencia por nombre de columna. Es una ayuda, no una decisión. */
  private sugerirMapeo(columnas: { indice: number; nombre: string }[]) {
    const patrones: Record<string, RegExp> = {
      numero_documento: /^(dni|n\.?°?\s*doc|nro\.?\s*doc|num\.?\s*doc|documento|c\.?i\.?)/i,
      apellido_paterno: /apellido\s*pat|ape\.?\s*pat/i,
      apellido_materno: /apellido\s*mat|ape\.?\s*mat/i,
      nombres: /^nombres?$/i,
      nombre_completo: /nombre\s*(completo|y\s*apellido)|apellidos?\s*y\s*nombres/i,
      sueldo_basico: /sueldo|remunerac|b[aá]sico|haber/i,
      fecha_ingreso: /fecha\s*(de\s*)?ingreso|f\.?\s*ingreso/i,
      fecha_nacimiento: /fecha\s*(de\s*)?nac|f\.?\s*nac/i,
      cargo: /cargo|puesto/i,
      area: /[aá]rea|secci[oó]n/i,
      sexo: /sexo|g[eé]nero/i,
      regimen_pensionario: /r[eé]gimen\s*pens|sistema\s*pens|onp\s*\/?\s*afp/i,
      nombre_afp: /^afp$/i,
      cuspp: /cuspp/i,
      tipo_comision_afp: /comisi[oó]n/i,
      tiene_hijos_menores: /asignaci[oó]n\s*fam|asig\.?\s*fam|hijos/i,
      cci_sueldo: /cci|cuenta\s*interbanc/i,
      email: /correo|e-?mail/i,
      telefono: /tel[eé]fono|celular/i,
    };

    const mapeo: Record<string, number> = {};
    for (const [campo, patron] of Object.entries(patrones)) {
      const col = columnas.find((c) => patron.test(c.nombre));
      if (col) mapeo[campo] = col.indice;
    }
    return mapeo;
  }

  /**
   * Paso 2: crea los trabajadores con el mapeo que confirmó el usuario.
   *
   * Cada fila se procesa por separado y en su propia transacción: si la fila 40 tiene
   * el DNI repetido, las 39 anteriores quedan creadas y el usuario ve exactamente qué
   * falló y por qué. Abortar todo por una fila mala obligaría a arreglar el Excel y
   * reintentar a ciegas.
   */
  async confirmar(dto: ConfirmarImportacionDto, userId: number) {
    const [empresa] = await this.dataSource.query(
      `SELECT e.id_empresa, e.razon_social, c.id_regimen_default
       FROM empresa e
       LEFT JOIN planilla_empresa_config c ON c.id_empresa = e.id_empresa AND c.estado_registro = 'ACTIVO'
       WHERE e.id_empresa = ? AND e.estado_registro = 'ACTIVO'`,
      [dto.id_empresa],
    );
    if (!empresa) throw new BadRequestException('La empresa indicada no existe');

    const idRegimen = dto.id_regimen ?? empresa.id_regimen_default;
    if (!idRegimen) {
      throw new BadRequestException(
        'Esta empresa no tiene régimen laboral configurado. Elige uno en el formulario o configúralo en Reglas de Cálculo.',
      );
    }

    const [regimen] = await this.dataSource.query(
      `SELECT id_regimen FROM planilla_regimen_laboral WHERE id_regimen = ? AND estado_registro = 'ACTIVO'`,
      [idRegimen],
    );
    if (!regimen) throw new BadRequestException('El régimen laboral indicado no existe');

    const afps = await this.dataSource.query(
      `SELECT id_afp, codigo, nombre FROM planilla_afp WHERE estado_registro = 'ACTIVO'`,
    );

    const resultados: any[] = [];
    let creados = 0;

    for (const fila of dto.filas) {
      const numeroFila = fila.fila ?? 0;
      try {
        const datos = this.interpretarFila(fila.valores, dto.mapeo, afps);
        await this.crearTrabajador(datos, dto.id_empresa, idRegimen, userId);
        creados++;
        resultados.push({ fila: numeroFila, estado: 'CREADO', documento: datos.numero_documento, nombre: `${datos.apellido_paterno} ${datos.nombres}` });
      } catch (e: any) {
        const mensaje = e?.code === 'ER_DUP_ENTRY'
          ? 'Ya existe un trabajador con ese documento en esta empresa'
          : e?.message ?? 'Error desconocido';
        resultados.push({ fila: numeroFila, estado: 'ERROR', motivo: mensaje });
      }
    }

    this.logger.log(`Importación de trabajadores en ${empresa.razon_social}: ${creados} de ${dto.filas.length}`);

    return {
      empresa: empresa.razon_social,
      total: dto.filas.length,
      creados,
      con_error: resultados.filter((r) => r.estado === 'ERROR').length,
      resultados,
    };
  }

  /** Traduce una fila cruda a los campos del trabajador, validando lo indispensable. */
  private interpretarFila(valores: Record<string, string>, mapeo: Record<string, number>, afps: any[]) {
    const leer = (campo: string): string => {
      const idx = mapeo[campo];
      if (!idx) return '';
      return String(valores[idx] ?? '').trim();
    };

    let apellidoPaterno = leer('apellido_paterno');
    let apellidoMaterno = leer('apellido_materno');
    let nombres = leer('nombres');

    // Muchos Excel traen "APELLIDOS Y NOMBRES" en una sola celda. Se parte asumiendo
    // el orden peruano: paterno, materno, y el resto son los nombres.
    if (!apellidoPaterno && !nombres) {
      const completo = leer('nombre_completo');
      if (completo) {
        const partes = completo.split(/\s+/);
        if (partes.length >= 3) {
          apellidoPaterno = partes[0];
          apellidoMaterno = partes[1];
          nombres = partes.slice(2).join(' ');
        } else if (partes.length === 2) {
          apellidoPaterno = partes[0];
          nombres = partes[1];
        }
      }
    }

    const numeroDocumento = leer('numero_documento').replace(/\D/g, '');
    if (!numeroDocumento) throw new Error('Falta el número de documento');
    if (!apellidoPaterno) throw new Error('Falta el apellido paterno');
    if (!nombres) throw new Error('Faltan los nombres');

    const sueldoTexto = leer('sueldo_basico').replace(/[^\d,.-]/g, '').replace(/,/g, '');
    const sueldo = Number(sueldoTexto);
    if (!sueldoTexto || Number.isNaN(sueldo) || sueldo < 0) {
      throw new Error(`Sueldo inválido: "${leer('sueldo_basico')}"`);
    }

    const fechaIngreso = this.interpretarFecha(leer('fecha_ingreso'));
    if (!fechaIngreso) throw new Error(`Fecha de ingreso inválida: "${leer('fecha_ingreso')}"`);

    // Régimen pensionario: si la columna dice algo que parezca AFP, o si hay una AFP
    // nombrada, se asume SPP. Si no, ONP, que es el default legal.
    const textoRegimen = `${leer('regimen_pensionario')} ${leer('nombre_afp')}`.toUpperCase();
    const nombreAfp = leer('nombre_afp').toUpperCase();
    const afpEncontrada = nombreAfp
      ? afps.find((a: any) => nombreAfp.includes(String(a.codigo).toUpperCase()) || String(a.nombre).toUpperCase().includes(nombreAfp))
      : null;

    const esAfp = /AFP|SPP|INTEGRA|PRIMA|PROFUTURO|HABITAT/.test(textoRegimen);
    const regimenPensionario = esAfp ? 'AFP' : (/ONP|SNP/.test(textoRegimen) ? 'ONP' : 'ONP');

    const comision = leer('tipo_comision_afp').toUpperCase();
    const tipoComision = regimenPensionario === 'AFP'
      ? (comision.includes('MIX') ? 'MIXTA' : 'FLUJO')
      : null;

    const af = leer('tiene_hijos_menores').toUpperCase();
    const tieneHijos = /^(S|SI|SÍ|1|X|TRUE|V)/.test(af);

    const sexoTexto = leer('sexo').toUpperCase();
    const sexo = sexoTexto.startsWith('F') ? 'F' : sexoTexto.startsWith('M') ? 'M' : null;

    return {
      numero_documento: numeroDocumento,
      apellido_paterno: apellidoPaterno.toUpperCase(),
      apellido_materno: apellidoMaterno ? apellidoMaterno.toUpperCase() : null,
      nombres: nombres.toUpperCase(),
      sueldo_basico: sueldo,
      fecha_ingreso: fechaIngreso,
      fecha_nacimiento: this.interpretarFecha(leer('fecha_nacimiento')),
      cargo: leer('cargo') || null,
      area: leer('area') || null,
      sexo,
      regimen_pensionario: regimenPensionario,
      id_afp: regimenPensionario === 'AFP' ? afpEncontrada?.id_afp ?? null : null,
      cuspp: leer('cuspp') || null,
      tipo_comision_afp: tipoComision,
      tiene_hijos_menores: tieneHijos ? 1 : 0,
      cci_sueldo: leer('cci_sueldo') || null,
      email: leer('email') || null,
      telefono: leer('telefono') || null,
      // Un DNI de 8 dígitos es DNI; cualquier otra longitud, carné de extranjería.
      cod_tipo_documento: numeroDocumento.length === 8 ? '01' : '04',
    };
  }

  /**
   * Fechas de Excel: pueden venir como texto 'dd/mm/aaaa', como ISO, o como el número
   * serial de Excel (días desde el 30/12/1899).
   */
  private interpretarFecha(valor: string): string | null {
    if (!valor) return null;

    // Serial de Excel.
    if (/^\d{5}$/.test(valor)) {
      const serial = Number(valor);
      const base = new Date(1899, 11, 30);
      base.setDate(base.getDate() + serial);
      return aFechaISO(base);
    }

    // dd/mm/aaaa o dd-mm-aaaa. Se asume día primero: es el formato peruano, y
    // asumir mes primero convertiría el 03/07 en 7 de marzo sin avisar.
    const m = valor.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
    if (m) {
      const dia = Number(m[1]);
      const mes = Number(m[2]);
      let anio = Number(m[3]);
      if (anio < 100) anio += anio < 50 ? 2000 : 1900;
      if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
      return aFechaISO(new Date(anio, mes - 1, dia));
    }

    return aFechaISO(valor);
  }

  /** Alta del trabajador con su sueldo de ingreso, en una sola transacción. */
  private async crearTrabajador(d: any, idEmpresa: number, idRegimen: number, userId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const res: any = await qr.query(
        `INSERT INTO planilla_trabajador
          (id_empresa, cod_tipo_documento, numero_documento, apellido_paterno, apellido_materno, nombres,
           fecha_nacimiento, sexo, email, telefono,
           id_regimen, cod_regimen_laboral_sunat, cod_tipo_contrato, cod_periodicidad, cod_situacion,
           cargo, area, fecha_ingreso, tiene_hijos_menores,
           regimen_pensionario, id_afp, cuspp, tipo_comision_afp, cci_sueldo,
           estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '01', '1', '01', '01', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`,
        [
          idEmpresa, d.cod_tipo_documento, d.numero_documento,
          d.apellido_paterno, d.apellido_materno, d.nombres,
          d.fecha_nacimiento, d.sexo, d.email, d.telefono,
          idRegimen, d.cargo, d.area, d.fecha_ingreso, d.tiene_hijos_menores,
          d.regimen_pensionario, d.id_afp, d.cuspp, d.tipo_comision_afp, d.cci_sueldo,
          userId,
        ],
      );
      const idNuevo = Number(res.insertId);

      await qr.query(
        `INSERT INTO planilla_trabajador_remuneracion
          (id_trabajador, vigencia_desde, sueldo_basico, moneda, motivo, observacion, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, 'PEN', 'INGRESO', 'Importado desde Excel', 'ACTIVO', ?)`,
        [idNuevo, d.fecha_ingreso, d.sueldo_basico, userId],
      );

      await qr.commitTransaction();
      return idNuevo;
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }
}

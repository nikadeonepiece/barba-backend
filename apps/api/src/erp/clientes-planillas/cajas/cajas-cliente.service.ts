import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { PdfService, pdfLayoutBordeado } from '@app/common';
import { AuditoriaService } from '@app/common';
import { CajasArchivoService } from '../../estudio-barba/tesoreria/cajas/cajas-archivo.service';
import { resolverEmpresaDelUsuario } from '../scope-empresa';
import { CreateGastoCajaClienteDto } from './dto/caja-cliente.dto';

/**
 * Misma definición de "cuenta para el saldo" que usa la intranet: registrado Y aprobado.
 *
 * Está copiada a propósito y no importada de `cajas.service.ts`. Es la excepción que
 * confirma la regla del área: acá se copia la CONDICIÓN (tres palabras que el estudio y
 * el portal tienen que leer igual), nunca el service — que no filtra por empresa y sería
 * justo el agujero que este módulo existe para evitar.
 *
 * Si esta condición cambia en un lado, cambia en los dos. Un cliente viendo un saldo
 * distinto al del estudio es peor que no ver saldo.
 *
 * Va con el alias `m.` explícito, al revés que en la intranet: allá vive dentro de un
 * subquery sobre una sola tabla, y acá las consultas unen `caja_chica` con
 * `caja_chica_movimiento` — las dos tienen `estado` y `estado_registro`, y sin el
 * prefijo MySQL corta con "Column 'estado' in field list is ambiguous".
 */
const CUENTA_PARA_SALDO = `m.estado = 'REGISTRADO' AND m.revision = 'APROBADO' AND m.estado_registro = 'ACTIVO'`;

const num = (v: any) => Number(v ?? 0);
const soles = (v: any) => `S/ ${num(v).toFixed(2)}`;
const fechaPe = (v: any) => (v ? new Date(v).toLocaleDateString('es-PE') : '—');

@Injectable()
export class CajasClienteService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private archivoService: CajasArchivoService,
    private pdfService: PdfService,
  ) {}

  /**
   * Las cajas de SU empresa. El `id_empresa` sale del token vía
   * `resolverEmpresaDelUsuario`, nunca del query: si viniera de la URL, cambiar un
   * número bastaría para ver la caja de otro cliente.
   */
  async findAll(user: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const filas = await this.dataSource.query(
      `SELECT cc.id_caja, cc.nombre, cc.responsable, cc.monto_inicial, cc.saldo_actual,
              cc.estado, cc.fecha_apertura, cc.fecha_cierre, cc.observaciones,
              COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO} AND m.tipo = 'INGRESO' THEN m.monto ELSE 0 END), 0) AS total_ingresos,
              COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO} AND m.tipo = 'EGRESO'  THEN m.monto ELSE 0 END), 0) AS total_egresos,
              COALESCE(SUM(CASE WHEN m.estado = 'REGISTRADO' AND m.revision = 'POR_REVISAR' THEN m.monto ELSE 0 END), 0) AS total_por_revisar,
              COALESCE(SUM(CASE WHEN m.estado = 'REGISTRADO' AND m.revision = 'POR_REVISAR' THEN 1 ELSE 0 END), 0) AS movimientos_por_revisar
       FROM caja_chica cc
       LEFT JOIN caja_chica_movimiento m ON m.id_caja = cc.id_caja AND m.estado_registro = 'ACTIVO'
       WHERE cc.id_empresa = ? AND cc.estado_registro = 'ACTIVO'
       GROUP BY cc.id_caja
       ORDER BY cc.estado ASC, cc.fecha_apertura DESC`,
      [idEmpresa],
    );

    return filas.map((f: any) => this.aNumeros(f));
  }

  /**
   * Una caja suya. El `id_empresa` va en el MISMO WHERE que el id: separar la
   * verificación en un `if` posterior es cómo aparece el caso que se olvidó.
   */
  async findOne(user: any, idCaja: number) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const [caja] = await this.dataSource.query(
      `SELECT cc.id_caja, cc.nombre, cc.responsable, cc.monto_inicial, cc.saldo_actual,
              cc.estado, cc.fecha_apertura, cc.fecha_cierre, cc.observaciones,
              e.razon_social, e.ruc,
              COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO} AND m.tipo = 'INGRESO' THEN m.monto ELSE 0 END), 0) AS total_ingresos,
              COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO} AND m.tipo = 'EGRESO'  THEN m.monto ELSE 0 END), 0) AS total_egresos,
              COALESCE(SUM(CASE WHEN m.estado = 'REGISTRADO' AND m.revision = 'POR_REVISAR' THEN m.monto ELSE 0 END), 0) AS total_por_revisar,
              COALESCE(SUM(CASE WHEN m.estado = 'REGISTRADO' AND m.revision = 'POR_REVISAR' THEN 1 ELSE 0 END), 0) AS movimientos_por_revisar
       FROM caja_chica cc
       INNER JOIN empresa e ON e.id_empresa = cc.id_empresa
       LEFT JOIN caja_chica_movimiento m ON m.id_caja = cc.id_caja AND m.estado_registro = 'ACTIVO'
       WHERE cc.id_caja = ? AND cc.id_empresa = ? AND cc.estado_registro = 'ACTIVO'
       GROUP BY cc.id_caja`,
      [idCaja, idEmpresa],
    );

    // 404 y no 403 a propósito: para este usuario esa caja no existe, y decirle
    // "existe pero no es tuya" ya es filtrar información de otro cliente.
    if (!caja) throw new NotFoundException('Caja no encontrada');
    return this.aNumeros(caja);
  }

  /** Catálogo de conceptos — el mismo que la intranet; es global y no tiene datos de nadie. */
  findConceptos() {
    return this.dataSource.query(
      `SELECT c.id_caja_concepto, c.codigo, c.nombre, c.tipo
       FROM caja_chica_concepto c
       WHERE c.estado_registro = 'ACTIVO' AND c.tipo IN ('GASTO', 'AMBOS')
       ORDER BY c.orden, c.nombre`,
    );
  }

  async findMovimientos(user: any, idCaja: number, query: any = {}, isExport = false) {
    await this.findOne(user, idCaja); // valida pertenencia antes de listar nada

    const page = isExport ? 1 : Number(query.page) || 1;
    const limit = isExport ? 5000 : Number(query.limit) || 20;
    const offset = (page - 1) * limit;

    const where: string[] = ["m.estado_registro = 'ACTIVO'"];
    const params: any[] = [idCaja];

    if (query.fecha_inicio) { where.push('m.fecha >= ?'); params.push(query.fecha_inicio); }
    if (query.fecha_fin) { where.push('m.fecha < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(query.fecha_fin); }
    if (query.revision === 'APROBADO' || query.revision === 'POR_REVISAR' || query.revision === 'RECHAZADO') {
      where.push('m.revision = ?');
      params.push(query.revision);
    }
    const whereSql = where.join(' AND ');

    const sqlData = `
      SELECT m.id_movimiento, m.tipo, m.fecha, m.monto, m.medio_pago,
             m.saldo_posterior, m.descripcion,
             m.tipo_comprobante, m.nro_comprobante, m.ruta_comprobante, m.nombre_comprobante,
             m.tabla_origen, m.estado, m.motivo_anulacion, m.revision, m.motivo_rechazo,
             c.nombre AS nombre_concepto
      FROM caja_chica_movimiento m
      LEFT JOIN caja_chica_concepto c ON c.id_caja_concepto = m.id_caja_concepto AND c.estado_registro = 'ACTIVO'
      WHERE m.id_caja = ? AND ${whereSql}
      ORDER BY m.fecha DESC, m.id_movimiento DESC
      LIMIT ? OFFSET ?`;

    if (isExport) return this.dataSource.query(sqlData, [...params, limit, offset]);

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(sqlData, [...params, limit, offset]),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM caja_chica_movimiento m WHERE m.id_caja = ? AND ${whereSql}`,
        params,
      ),
    ]);

    return { data: data.map((f: any) => this.aNumeros(f)), meta: { total: Number(total), page, limit } };
  }

  /**
   * Registra un gasto de la empresa. Nace POR_REVISAR y NO toca el saldo.
   *
   * Por eso no hay transacción ni recálculo de saldos: un movimiento por revisar tiene
   * delta 0 en la cadena, así que no hay nada que rearmar. `saldo_anterior` y
   * `saldo_posterior` quedan en NULL y los llena el recálculo de la intranet cuando el
   * estudio lo aprueba — que es también cuando pasan a significar algo.
   */
  async crearGasto(user: any, dto: CreateGastoCajaClienteDto, userId: number) {
    const caja = await this.findOne(user, dto.id_caja);

    if (caja.estado === 'CERRADA') {
      throw new BadRequestException(
        'Esta caja está cerrada y ya no acepta gastos. Consultá con el estudio si necesitás una caja nueva.',
      );
    }

    // El concepto es opcional, pero si viene tiene que existir y ser de gasto: el
    // cliente solo registra egresos.
    let idConcepto: number | null = null;
    if (dto.id_caja_concepto) {
      const [concepto] = await this.dataSource.query(
        `SELECT id_caja_concepto FROM caja_chica_concepto
         WHERE id_caja_concepto = ? AND estado_registro = 'ACTIVO' AND tipo IN ('GASTO', 'AMBOS')`,
        [dto.id_caja_concepto],
      );
      if (!concepto) throw new BadRequestException('El concepto elegido no existe o no sirve para un gasto');
      idConcepto = Number(concepto.id_caja_concepto);
    }

    try {
      const res: any = await this.dataSource.query(
        `INSERT INTO caja_chica_movimiento
          (id_caja, id_caja_concepto, tipo, fecha, monto, medio_pago,
           descripcion, tipo_comprobante, nro_comprobante, ruta_comprobante, nombre_comprobante,
           estado, revision, estado_registro, id_usuario_crea)
         VALUES (?, ?, 'EGRESO', ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTRADO', 'POR_REVISAR', 'ACTIVO', ?)`,
        [
          dto.id_caja, idConcepto, dto.fecha, num(dto.monto), dto.medio_pago ?? 'EFECTIVO',
          dto.descripcion.trim(),
          dto.tipo_comprobante ?? 'NINGUNO',
          dto.nro_comprobante?.trim() || null,
          dto.ruta_comprobante || null,
          dto.nombre_comprobante?.trim() || null,
          userId,
        ],
      );
      const idNuevo = Number(res.insertId);

      await this.auditoriaService.registrar('caja_chica_movimiento', idNuevo, 'CREAR', userId, null, {
        ...dto, origen: 'PORTAL_CLIENTE', revision: 'POR_REVISAR',
      });

      return {
        id: idNuevo,
        mensaje: 'Gasto enviado. El estudio lo va a revisar antes de que descuente del saldo.',
      };
    } catch (error) {
      // La subida es un paso aparte: si el INSERT falla, el archivo ya está en disco y
      // sin esto queda huérfano para siempre.
      this.archivoService.borrarSiExiste(dto.ruta_comprobante);
      throw error;
    }
  }

  /**
   * Manda el comprobante de un movimiento de SU caja.
   *
   * El `id_empresa` entra en el JOIN, no en un `if` después de leer: sin eso, un id de
   * movimiento de otra empresa devolvería su boleta.
   */
  async descargarComprobante(user: any, idMovimiento: number, res: Response) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const [mov] = await this.dataSource.query(
      `SELECT m.ruta_comprobante, m.nombre_comprobante
       FROM caja_chica_movimiento m
       INNER JOIN caja_chica cc ON cc.id_caja = m.id_caja
       WHERE m.id_movimiento = ? AND cc.id_empresa = ?
         AND m.estado_registro = 'ACTIVO' AND cc.estado_registro = 'ACTIVO'`,
      [idMovimiento, idEmpresa],
    );
    if (!mov) throw new NotFoundException('Movimiento no encontrado');
    if (!mov.ruta_comprobante) throw new NotFoundException('Este movimiento no tiene comprobante adjunto');

    this.archivoService.enviar(mov.ruta_comprobante, mov.nombre_comprobante, res);
  }

  /**
   * Estado de cuenta de SU caja en PDF.
   *
   * Marca los gastos POR_REVISAR en el mismo cuadro en vez de esconderlos: el cliente
   * tiene que poder ver que ya los mandó y que todavía no descuentan, o los vuelve a
   * cargar creyendo que se perdieron.
   */
  async exportarPdf(user: any, idCaja: number, query: any, res: Response) {
    const caja = await this.findOne(user, idCaja);
    const movimientos = (await this.findMovimientos(user, idCaja, query, true)) as any[];

    const periodo = query?.fecha_inicio || query?.fecha_fin
      ? `Periodo ${fechaPe(query.fecha_inicio)} a ${fechaPe(query.fecha_fin)}`
      : 'Histórico completo';

    const cuenta = (m: any) => m.estado === 'REGISTRADO' && m.revision === 'APROBADO';
    const aprobados = movimientos.filter(cuenta);
    const ingresos = aprobados.filter((m) => m.tipo === 'INGRESO').reduce((a, m) => a + num(m.monto), 0);
    const egresos = aprobados.filter((m) => m.tipo === 'EGRESO').reduce((a, m) => a + num(m.monto), 0);
    const porRevisar = movimientos.filter((m) => m.estado === 'REGISTRADO' && m.revision === 'POR_REVISAR');

    const etiquetaEstado = (m: any) => {
      if (m.estado === 'ANULADO') return `ANULADO: ${m.motivo_anulacion || 'sin motivo'}`;
      if (m.revision === 'POR_REVISAR') return 'POR REVISAR';
      if (m.revision === 'RECHAZADO') return `RECHAZADO: ${m.motivo_rechazo || 'sin motivo'}`;
      return '';
    };

    const body = [
      ['FECHA', 'CONCEPTO', 'DESCRIPCIÓN', 'COMPROBANTE', 'INGRESO', 'EGRESO', 'ESTADO'].map((text) => ({
        text, bold: true, fontSize: 8,
      })),
      ...movimientos.map((m) => {
        const suma = cuenta(m);
        const color = suma ? undefined : '#999999';
        return [
          { text: fechaPe(m.fecha), fontSize: 7.5, color },
          { text: m.nombre_concepto || (m.tabla_origen === 'caja_chica_apertura' ? 'Apertura de caja' : '—'), fontSize: 7.5, color },
          { text: m.descripcion || '—', fontSize: 7.5, color },
          { text: [m.tipo_comprobante !== 'NINGUNO' ? m.tipo_comprobante : null, m.nro_comprobante].filter(Boolean).join(' ') || '—', fontSize: 7.5, color },
          { text: suma && m.tipo === 'INGRESO' ? soles(m.monto) : '', fontSize: 7.5, alignment: 'right' as const, color },
          { text: suma && m.tipo === 'EGRESO' ? soles(m.monto) : '', fontSize: 7.5, alignment: 'right' as const, color },
          { text: etiquetaEstado(m), fontSize: 7, color },
        ];
      }),
      [
        { text: `TOTAL APROBADO (${aprobados.length} movimientos)`, bold: true, fontSize: 8, colSpan: 4 },
        { text: '' }, { text: '' }, { text: '' },
        { text: soles(ingresos), bold: true, fontSize: 8, alignment: 'right' as const },
        { text: soles(egresos), bold: true, fontSize: 8, alignment: 'right' as const },
        { text: '' },
      ],
    ];

    await this.pdfService.generarPdf(
      {
        pageOrientation: 'landscape',
        pageMargins: [25, 25, 25, 30],
        content: [
          { text: `Estado de cuenta — ${caja.nombre}`, fontSize: 14, bold: true },
          { text: `${caja.razon_social} · RUC ${caja.ruc}`, fontSize: 10, margin: [0, 2, 0, 0] },
          {
            text: `${periodo} · Responsable: ${caja.responsable || '—'} · Saldo disponible ${soles(caja.saldo_actual)}`,
            fontSize: 9, color: '#333333', margin: [0, 4, 0, 12],
          },
          {
            table: { headerRows: 1, widths: ['auto', 'auto', '*', 'auto', 'auto', 'auto', 'auto'], body },
            layout: pdfLayoutBordeado('#dddddd'),
          },
          {
            text: porRevisar.length
              ? `Las filas en gris no están en el saldo. ${porRevisar.length} gasto(s) por ${soles(porRevisar.reduce((a, m) => a + num(m.monto), 0))} esperan revisión del estudio.`
              : 'Las filas en gris no están en el saldo.',
            fontSize: 7.5, color: '#666666', margin: [0, 10, 0, 0],
          },
        ],
        defaultStyle: { font: 'Helvetica' },
      },
      `caja-${String(caja.nombre || 'caja').replace(/[^a-zA-Z0-9]+/g, '_')}`,
      res,
    );
  }

  /** Mismo motivo que en la intranet: el driver devuelve DECIMAL y COUNT como string. */
  private aNumeros(fila: any) {
    for (const campo of ['monto_inicial', 'saldo_actual', 'total_ingresos', 'total_egresos',
      'total_por_revisar', 'movimientos_por_revisar', 'monto', 'saldo_posterior']) {
      if (fila?.[campo] !== undefined && fila[campo] !== null) fila[campo] = Number(fila[campo]);
    }
    return fila;
  }
}

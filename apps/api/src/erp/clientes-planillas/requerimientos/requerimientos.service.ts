import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { AuditoriaService, ExcelService, PdfHtmlService } from '@app/common';
import { RequerimientosArchivoService } from './requerimientos-archivo.service';
import { resolverLinea, totalesPorMoneda, num } from './requerimiento-lineas';
import { empresaEfectiva, esUsuarioDePortal, asegurarEmpresaPropia } from '../scope-empresa';
import {
  CreateRequerimientoDto, UpdateRequerimientoDto, CreateDetalleRequerimientoDto,
} from './dto/requerimiento.dto';

/** `ORDER BY` dinámico: la columna sale de esta whitelist, nunca del query string. */
const COLS_ORDER: Record<string, string> = {
  id: 'r.id_requerimiento',
  fecha: 'r.fecha_registro',
  empresa: 'e.razon_social',
  proveedor: 't.razon_social',
  total: 'r.total',
  estado: 'r.estado_aprobacion',
  prioridad: 'r.prioridad',
};

/**
 * Requerimientos de compra — la pantalla que REGISTRA el pedido.
 *
 * Portado de `taller/requerimientos` de Transportes Montero. La decisión (aprobar o
 * rechazar) vive en el otro módulo: `aprobacion-requerimientos`. Acá no hay un solo
 * `UPDATE` de `estado_aprobacion` a propósito — quien pide no decide.
 *
 * ── Qué se puede editar y hasta cuándo ──
 *
 * Solo mientras el requerimiento está PENDIENTE. Una vez aprobado ya existe una orden
 * de pago en tesorería con ese monto; cambiar el ítem acá dejaría la orden diciendo
 * una cosa y el requerimiento otra, y quien pague mira la orden.
 */
@Injectable()
export class RequerimientosService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private readonly archivoService: RequerimientosArchivoService,
    private readonly excelService: ExcelService,
    private readonly pdfHtmlService: PdfHtmlService,
  ) {}

  // ── LISTADO ─────────────────────────────────────────────────────────────────

  private filtros(query: any, user?: any) {
    const where: string[] = [`r.estado_registro = 'ACTIVO'`];
    const params: any[] = [];

    // Para una cuenta de portal esto devuelve SU empresa y descarta lo que mandó el
    // frontend; para el estudio, lo que eligió en el desplegable (o nada).
    const empresa = empresaEfectiva(user, query.id_empresa);
    if (empresa) { where.push('r.id_empresa = ?'); params.push(empresa); }
    if (query.id_tercero_proveedor) { where.push('r.id_tercero_proveedor = ?'); params.push(Number(query.id_tercero_proveedor)); }
    if (query.estado_aprobacion) { where.push('r.estado_aprobacion = ?'); params.push(query.estado_aprobacion); }
    if (query.prioridad) { where.push('r.prioridad = ?'); params.push(query.prioridad); }
    if (query.fecha_desde) { where.push('r.fecha_registro >= ?'); params.push(query.fecha_desde); }
    // `<=` y no `<` porque `fecha_registro` es DATE, no DATETIME: acá no se pierde el
    // último día. Si algún día pasa a DATETIME, esto tiene que volverse
    // `< DATE_ADD(?, INTERVAL 1 DAY)`.
    if (query.fecha_hasta) { where.push('r.fecha_registro <= ?'); params.push(query.fecha_hasta); }

    if (query.search) {
      const like = `%${String(query.search).trim()}%`;
      where.push(`(r.nro_comprobante LIKE ? OR r.observacion LIKE ? OR t.razon_social LIKE ? OR e.razon_social LIKE ?
                   OR EXISTS (SELECT 1 FROM requerimiento_detalle d2
                               WHERE d2.id_requerimiento = r.id_requerimiento
                                 AND d2.estado_registro = 'ACTIVO' AND d2.detalle LIKE ?))`);
      params.push(like, like, like, like, like);
    }

    return { whereSql: where.join(' AND '), params };
  }

  private readonly JOINS_LISTADO = `
    FROM requerimiento r
    INNER JOIN empresa e ON e.id_empresa = r.id_empresa
    LEFT JOIN tesoreria_tercero t ON t.id_tercero = r.id_tercero_proveedor
    LEFT JOIN planilla_trabajador ts ON ts.id_trabajador = r.id_trabajador_solicitante
    LEFT JOIN tesoreria_medio_pago mp ON mp.id_medio_pago = r.id_medio_pago AND mp.estado_registro = 'ACTIVO'
  `;

  private readonly COLS_LISTADO = `
    r.id_requerimiento, r.id_empresa, r.fecha_registro, r.fecha_vencimiento,
    r.id_tercero_proveedor, r.id_trabajador_solicitante, r.id_trabajador_encargado, r.id_medio_pago,
    r.tipo_comprobante, r.nro_comprobante, r.ruta_comprobante, r.nombre_comprobante,
    r.prioridad, r.observacion, r.total, r.total_dolares,
    r.estado_aprobacion, r.fecha_aprobacion, r.motivo_rechazo,
    r.id_orden_pago, r.id_orden_pago_dolares,
    e.razon_social AS nombre_empresa, e.ruc AS ruc_empresa,
    t.razon_social AS nombre_proveedor, t.numero_documento AS doc_proveedor,
    CONCAT_WS(' ', ts.nombres, ts.apellido_paterno) AS nombre_solicitante,
    mp.nombre AS nombre_medio_pago,
    (SELECT COUNT(*) FROM requerimiento_detalle d
      WHERE d.id_requerimiento = r.id_requerimiento AND d.estado_registro = 'ACTIVO') AS total_items
  `;

  async findAll(query: any = {}, isExport = false, user?: any) {
    const page = isExport ? 1 : Number(query.page) || 1;
    const limit = isExport ? 5000 : Number(query.limit) || 20;
    const offset = (page - 1) * limit;
    const { whereSql, params } = this.filtros(query, user);

    const col = COLS_ORDER[query.sortCol] ?? 'r.id_requerimiento';
    const dir = query.sortDir === 'ASC' ? 'ASC' : 'DESC';

    const sqlData = `
      SELECT ${this.COLS_LISTADO}
      ${this.JOINS_LISTADO}
      WHERE ${whereSql}
      ORDER BY ${col} ${dir}
      LIMIT ? OFFSET ?`;

    if (isExport) {
      const filas = await this.dataSource.query(sqlData, [...params, limit, offset]);
      return filas.map((f: any) => ({ ...f, total: num(f.total), total_dolares: num(f.total_dolares), total_items: Number(f.total_items) }));
    }

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(sqlData, [...params, limit, offset]),
      this.dataSource.query(`SELECT COUNT(*) AS total ${this.JOINS_LISTADO} WHERE ${whereSql}`, params),
    ]);

    return {
      data: data.map((f: any) => ({ ...f, total: num(f.total), total_dolares: num(f.total_dolares), total_items: Number(f.total_items) })),
      meta: { total: Number(total), page, limit },
    };
  }

  async findOne(id: number, user?: any) {
    // `const [row]` obligatorio: `query()` devuelve un ARRAY, que siempre es truthy.
    const [cabecera] = await this.dataSource.query(
      `SELECT ${this.COLS_LISTADO},
              CONCAT_WS(' ', te.nombres, te.apellido_paterno) AS nombre_encargado,
              CONCAT_WS(' ', ua.nombres, ua.apellidos) AS usuario_aprueba
       ${this.JOINS_LISTADO}
       LEFT JOIN planilla_trabajador te ON te.id_trabajador = r.id_trabajador_encargado
       LEFT JOIN sis_usuario ua ON ua.id_usuario = r.id_usuario_aprueba
       WHERE r.id_requerimiento = ? AND r.estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!cabecera) throw new NotFoundException('El requerimiento no existe o fue dado de baja.');
    // Filtrar el listado no impide pedir un id que nunca se vio: este es el otro candado.
    asegurarEmpresaPropia(user, cabecera.id_empresa);

    const detalles = await this.dataSource.query(
      `SELECT d.id_detalle, d.id_centro_costo_concepto, d.detalle, d.cantidad, d.precio_unitario,
              d.modo_ingreso, d.con_igv, d.pago_dolares, d.subtotal,
              cc.nombre AS nombre_concepto,
              s.nombre AS nombre_subcategoria, c.nombre AS nombre_categoria
         FROM requerimiento_detalle d
         LEFT JOIN centro_costo_concepto cc ON cc.id_centro_costo_concepto = d.id_centro_costo_concepto
         LEFT JOIN centro_costo_subcategoria s ON s.id_centro_costo_subcategoria = cc.id_centro_costo_subcategoria
         LEFT JOIN centro_costo_categoria c ON c.id_centro_costo_categoria = s.id_centro_costo_categoria
        WHERE d.id_requerimiento = ? AND d.estado_registro = 'ACTIVO'
        ORDER BY d.id_detalle ASC`,
      [id],
    );

    return {
      ...cabecera,
      total: num(cabecera.total),
      total_dolares: num(cabecera.total_dolares),
      detalles: detalles.map((d: any) => ({
        ...d,
        cantidad: num(d.cantidad),
        precio_unitario: num(d.precio_unitario),
        subtotal: num(d.subtotal),
        con_igv: Number(d.con_igv),
        pago_dolares: Number(d.pago_dolares),
      })),
    };
  }

  // ── VALIDACIÓN DE COHERENCIA ────────────────────────────────────────────────

  /**
   * Todo lo que el requerimiento referencia tiene que ser de la MISMA empresa.
   *
   * Sin esto, el formulario podría mandar el proveedor de una empresa con el centro de
   * costo de otra: los dos IDs existen, el INSERT pasa, y el error recién se ve cuando
   * el gasto aparece imputado donde no corresponde. Se valida en el backend y no solo
   * acotando los desplegables porque el desplegable es sugerencia, no candado.
   */
  private async validarPertenencia(
    qr: QueryRunner,
    idEmpresa: number,
    dto: { id_tercero_proveedor?: number; id_trabajador_solicitante?: number; id_trabajador_encargado?: number; id_medio_pago?: number },
    detalles: CreateDetalleRequerimientoDto[],
  ) {
    const [empresa] = await qr.query(
      `SELECT id_empresa FROM empresa WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!empresa) throw new NotFoundException('La empresa seleccionada no existe o está dada de baja.');

    if (dto.id_tercero_proveedor) {
      const [prov] = await qr.query(
        `SELECT id_tercero FROM tesoreria_tercero
          WHERE id_tercero = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
        [dto.id_tercero_proveedor, idEmpresa],
      );
      if (!prov) throw new BadRequestException('El proveedor elegido no pertenece a la empresa del requerimiento.');
    }

    for (const [campo, idTrabajador] of [
      ['solicitante', dto.id_trabajador_solicitante],
      ['encargado', dto.id_trabajador_encargado],
    ] as const) {
      if (!idTrabajador) continue;
      const [trab] = await qr.query(
        `SELECT id_trabajador FROM planilla_trabajador
          WHERE id_trabajador = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
        [idTrabajador, idEmpresa],
      );
      if (!trab) throw new BadRequestException(`El ${campo} elegido no pertenece a la empresa del requerimiento.`);
    }

    if (dto.id_medio_pago) {
      const [mp] = await qr.query(
        `SELECT id_medio_pago FROM tesoreria_medio_pago WHERE id_medio_pago = ? AND estado_registro = 'ACTIVO'`,
        [dto.id_medio_pago],
      );
      if (!mp) throw new BadRequestException('El medio de pago elegido no existe.');
    }

    // Conceptos: una sola query con `IN`, nunca una por línea dentro del loop.
    const idsConcepto = [...new Set(detalles.map((d) => d.id_centro_costo_concepto).filter(Boolean))] as number[];
    if (idsConcepto.length) {
      const filas = await qr.query(
        `SELECT cc.id_centro_costo_concepto
           FROM centro_costo_concepto cc
           INNER JOIN centro_costo_subcategoria s ON s.id_centro_costo_subcategoria = cc.id_centro_costo_subcategoria
           INNER JOIN centro_costo_categoria c ON c.id_centro_costo_categoria = s.id_centro_costo_categoria
          WHERE cc.id_centro_costo_concepto IN (${idsConcepto.map(() => '?').join(',')})
            AND c.id_empresa = ?
            AND cc.estado_registro = 'ACTIVO' AND s.estado_registro = 'ACTIVO' AND c.estado_registro = 'ACTIVO'`,
        [...idsConcepto, idEmpresa],
      );
      if (filas.length !== idsConcepto.length) {
        throw new BadRequestException(
          'Algún centro de costo elegido no existe o no pertenece a la empresa del requerimiento.',
        );
      }
    }
  }

  /** Resuelve las líneas y devuelve lo que se va a guardar más los totales por moneda. */
  private prepararLineas(detalles: CreateDetalleRequerimientoDto[]) {
    if (!detalles?.length) throw new BadRequestException('El requerimiento necesita al menos un ítem.');

    const lineas = detalles.map((det) => {
      const resuelta = resolverLinea({
        cantidad: det.cantidad,
        precio_unitario: det.precio_unitario,
        subtotal: det.subtotal,
        con_igv: det.con_igv,
        modo_ingreso: det.modo_ingreso,
      });
      return {
        id_detalle: det.id_detalle ?? null,
        id_centro_costo_concepto: det.id_centro_costo_concepto ?? null,
        detalle: det.detalle.trim(),
        cantidad: Number(det.cantidad),
        con_igv: det.con_igv ? 1 : 0,
        pago_dolares: det.pago_dolares ? 1 : 0,
        ...resuelta,
      };
    });

    const { total, total_dolares } = totalesPorMoneda(lineas);
    if (total <= 0 && total_dolares <= 0) {
      throw new BadRequestException('El requerimiento no puede quedar en cero: revisá las cantidades y los precios.');
    }

    return { lineas, total, total_dolares };
  }

  // ── ALTA ────────────────────────────────────────────────────────────────────

  async create(dto: CreateRequerimientoDto, user: any) {
    const userId = user.userId;
    // Para el portal la empresa sale del token: lo que mandó el formulario se descarta.
    const idEmpresa = empresaEfectiva(user, dto.id_empresa) ?? dto.id_empresa;
    const { lineas, total, total_dolares } = this.prepararLineas(dto.detalles);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.validarPertenencia(qr, idEmpresa, dto, dto.detalles);

      const res: any = await qr.query(
        `INSERT INTO requerimiento
          (id_empresa, fecha_registro, fecha_vencimiento,
           id_tercero_proveedor, id_trabajador_solicitante, id_trabajador_encargado, id_medio_pago,
           tipo_comprobante, nro_comprobante, ruta_comprobante, nombre_comprobante,
           prioridad, observacion, total, total_dolares,
           estado_aprobacion, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', 'ACTIVO', ?)`,
        [
          idEmpresa, dto.fecha_registro, dto.fecha_vencimiento || null,
          dto.id_tercero_proveedor || null, dto.id_trabajador_solicitante || null,
          dto.id_trabajador_encargado || null, dto.id_medio_pago || null,
          dto.tipo_comprobante || 'NINGUNO', dto.nro_comprobante?.trim() || null,
          dto.ruta_comprobante || null, dto.nombre_comprobante?.trim() || null,
          dto.prioridad || 'MEDIO', dto.observacion?.trim() || null,
          total, total_dolares, userId,
        ],
      );
      const idRequerimiento = Number(res.insertId);

      await this.insertarLineas(qr, idRequerimiento, lineas, userId);

      await this.auditoriaService.registrarConTransaccion(
        qr, 'requerimiento', idRequerimiento, 'CREAR', userId, null, { ...dto, id_empresa: idEmpresa, total, total_dolares },
      );

      await qr.commitTransaction();
      return { id: idRequerimiento, mensaje: 'Requerimiento registrado correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      // La subida es un paso aparte del guardado: si el INSERT falla, el archivo ya
      // está en disco y sin esto queda huérfano para siempre.
      this.archivoService.borrarSiExiste(dto.ruta_comprobante);
      throw error;
    } finally {
      // SIEMPRE en `finally`: sin esto, una excepción agota el pool de conexiones y se
      // cae el ERP entero, no solo esta pantalla.
      await qr.release();
    }
  }

  /** Un solo INSERT con N `VALUES`, nunca N INSERT dentro de un loop. */
  private async insertarLineas(qr: QueryRunner, idRequerimiento: number, lineas: any[], userId: number) {
    const valores: any[] = [];
    const placeholders = lineas
      .map((l) => {
        valores.push(
          idRequerimiento, l.id_centro_costo_concepto, l.detalle, l.cantidad,
          l.precio_unitario, l.modo_ingreso, l.con_igv, l.pago_dolares, l.subtotal, userId,
        );
        return '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      })
      .join(', ');

    await qr.query(
      `INSERT INTO requerimiento_detalle
        (id_requerimiento, id_centro_costo_concepto, detalle, cantidad,
         precio_unitario, modo_ingreso, con_igv, pago_dolares, subtotal, id_usuario_crea)
       VALUES ${placeholders}`,
      valores,
    );
  }

  // ── EDICIÓN ─────────────────────────────────────────────────────────────────

  async update(id: number, dto: UpdateRequerimientoDto, user: any) {
    const userId = user.userId;

    const [actual] = await this.dataSource.query(
      `SELECT * FROM requerimiento WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!actual) throw new NotFoundException('El requerimiento no existe o fue dado de baja.');
    asegurarEmpresaPropia(user, actual.id_empresa);

    if (actual.estado_aprobacion !== 'PENDIENTE') {
      throw new BadRequestException(
        actual.estado_aprobacion === 'APROBADO'
          ? 'Este requerimiento ya fue aprobado y tiene una orden de pago generada. Para cambiarlo, finanzas tiene que revertir la aprobación primero.'
          : 'Este requerimiento fue rechazado. Registrá uno nuevo en vez de editar el rechazado: así queda el historial de lo que se pidió y por qué se rechazó.',
      );
    }

    // El portal no puede MUDAR un requerimiento a otra empresa aunque mande otro id.
    const idEmpresa = empresaEfectiva(user, dto.id_empresa) ?? dto.id_empresa ?? actual.id_empresa;
    const detalles = dto.detalles ?? [];
    const { lineas, total, total_dolares } = this.prepararLineas(detalles);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.validarPertenencia(qr, idEmpresa, { ...actual, ...dto }, detalles);

      const res: any = await qr.query(
        `UPDATE requerimiento
            SET id_empresa = ?, fecha_registro = ?, fecha_vencimiento = ?,
                id_tercero_proveedor = ?, id_trabajador_solicitante = ?, id_trabajador_encargado = ?,
                id_medio_pago = ?, tipo_comprobante = ?, nro_comprobante = ?,
                prioridad = ?, observacion = ?, total = ?, total_dolares = ?, id_usuario_mod = ?
          WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO' AND estado_aprobacion = 'PENDIENTE'`,
        [
          idEmpresa, dto.fecha_registro ?? actual.fecha_registro, dto.fecha_vencimiento || null,
          dto.id_tercero_proveedor || null, dto.id_trabajador_solicitante || null,
          dto.id_trabajador_encargado || null, dto.id_medio_pago || null,
          dto.tipo_comprobante || 'NINGUNO', dto.nro_comprobante?.trim() || null,
          dto.prioridad || actual.prioridad, dto.observacion?.trim() || null,
          total, total_dolares, userId, id,
        ],
      );
      // El `AND estado_aprobacion = 'PENDIENTE'` del WHERE es un candado, no un filtro:
      // si alguien aprobó el requerimiento entre la lectura y este UPDATE, acá no se
      // actualiza nada y hay que avisar en vez de responder que salió bien.
      if (res.affectedRows === 0) {
        throw new ConflictException('El requerimiento cambió de estado mientras lo editabas. Volvé a abrirlo para ver cómo quedó.');
      }

      // Las líneas se reemplazan enteras: se dan de baja las viejas y se insertan las
      // nuevas. Los ítems no tienen vida propia fuera del requerimiento (nadie los
      // referencia), así que reconciliar una por una solo agregaría casos de borde.
      await qr.query(
        `UPDATE requerimiento_detalle SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
          WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
        [userId, id],
      );
      await this.insertarLineas(qr, id, lineas, userId);

      await this.auditoriaService.registrarConTransaccion(
        qr, 'requerimiento', id, 'ACTUALIZAR', userId, actual, { ...dto, total, total_dolares },
      );

      await qr.commitTransaction();
      return { mensaje: 'Requerimiento actualizado correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  // ── BAJA ────────────────────────────────────────────────────────────────────

  async remove(id: number, user: any) {
    const userId = user.userId;

    const [actual] = await this.dataSource.query(
      `SELECT * FROM requerimiento WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!actual) throw new NotFoundException('El requerimiento no existe o ya fue dado de baja.');
    asegurarEmpresaPropia(user, actual.id_empresa);

    if (actual.estado_aprobacion === 'APROBADO') {
      throw new ConflictException(
        'No se puede dar de baja un requerimiento aprobado: ya tiene una orden de pago en tesorería. ' +
        'Si el gasto no va, finanzas tiene que revertir la aprobación y recién ahí se puede eliminar.',
      );
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const res: any = await qr.query(
        `UPDATE requerimiento SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
          WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO' AND estado_aprobacion <> 'APROBADO'`,
        [userId, id],
      );
      if (res.affectedRows === 0) {
        throw new ConflictException('El requerimiento cambió de estado mientras lo eliminabas. Volvé a abrir el listado.');
      }

      // Las líneas se bajan también: dejarlas ACTIVAS colgando de una cabecera
      // eliminada las deja apareciendo en cualquier consulta que arranque por el
      // detalle (un reporte por centro de costo, por ejemplo).
      await qr.query(
        `UPDATE requerimiento_detalle SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
          WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
        [userId, id],
      );

      await this.auditoriaService.registrarConTransaccion(qr, 'requerimiento', id, 'ELIMINAR', userId, actual, null);

      await qr.commitTransaction();
      // El comprobante se borra DESPUÉS del commit: si se borrara antes y la
      // transacción fallara, el registro quedaría vivo apuntando a un archivo que ya no está.
      this.archivoService.borrarSiExiste(actual.ruta_comprobante);
      return { mensaje: 'Requerimiento eliminado correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  // ── COMPROBANTE ADJUNTO ─────────────────────────────────────────────────────

  async guardarComprobante(id: number, archivo: any, user: any) {
    const userId = user.userId;
    if (!archivo) throw new BadRequestException('No llegó ningún archivo.');

    const [actual] = await this.dataSource.query(
      `SELECT id_requerimiento, id_empresa, ruta_comprobante, estado_aprobacion FROM requerimiento
        WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!actual) {
      this.archivoService.borrarSiExiste(archivo.filename);
      throw new NotFoundException('El requerimiento no existe o fue dado de baja.');
    }
    try {
      asegurarEmpresaPropia(user, actual.id_empresa);
    } catch (error) {
      // El archivo ya está en disco: sin esto queda huérfano cada vez que alguien
      // apunta al requerimiento de otra empresa.
      this.archivoService.borrarSiExiste(archivo.filename);
      throw error;
    }

    const rutaNueva = `/requerimiento-comprobantes/${archivo.filename}`;
    const res: any = await this.dataSource.query(
      `UPDATE requerimiento SET ruta_comprobante = ?, nombre_comprobante = ?, id_usuario_mod = ?
        WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [rutaNueva, archivo.originalname, userId, id],
    );
    if (res.affectedRows === 0) {
      this.archivoService.borrarSiExiste(rutaNueva);
      throw new NotFoundException('El requerimiento no existe o fue dado de baja.');
    }

    // Recién ahora se borra el anterior: si se borrara antes del UPDATE y este fallara,
    // el registro quedaría apuntando a un archivo inexistente.
    if (actual.ruta_comprobante) this.archivoService.borrarSiExiste(actual.ruta_comprobante);

    await this.auditoriaService.registrar(
      'requerimiento', id, 'ACTUALIZAR', userId,
      { ruta_comprobante: actual.ruta_comprobante }, { ruta_comprobante: rutaNueva },
    );
    return { ruta_comprobante: rutaNueva, nombre_comprobante: archivo.originalname, mensaje: 'Comprobante adjuntado correctamente' };
  }

  async verComprobante(id: number, res: Response, user?: any) {
    const [row] = await this.dataSource.query(
      `SELECT id_empresa, ruta_comprobante, nombre_comprobante FROM requerimiento
        WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!row) throw new NotFoundException('El requerimiento no existe o fue dado de baja.');
    asegurarEmpresaPropia(user, row.id_empresa);
    if (!row.ruta_comprobante) throw new NotFoundException('Este requerimiento no tiene comprobante adjunto.');

    this.archivoService.enviar(row.ruta_comprobante, row.nombre_comprobante || `requerimiento-${id}`, res);
  }

  async eliminarComprobante(id: number, user: any) {
    const userId = user.userId;

    const [row] = await this.dataSource.query(
      `SELECT id_empresa, ruta_comprobante FROM requerimiento WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!row) throw new NotFoundException('El requerimiento no existe o fue dado de baja.');
    asegurarEmpresaPropia(user, row.id_empresa);
    if (!row.ruta_comprobante) throw new BadRequestException('Este requerimiento no tiene comprobante adjunto.');

    await this.dataSource.query(
      `UPDATE requerimiento SET ruta_comprobante = NULL, nombre_comprobante = NULL, id_usuario_mod = ?
        WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    this.archivoService.borrarSiExiste(row.ruta_comprobante);

    await this.auditoriaService.registrar(
      'requerimiento', id, 'ACTUALIZAR', userId, { ruta_comprobante: row.ruta_comprobante }, { ruta_comprobante: null },
    );
    return { mensaje: 'Comprobante eliminado correctamente' };
  }

  // ── CATÁLOGOS DE LOS ng-select ──────────────────────────────────────────────
  // Todos son catálogos ABIERTOS (crecen con el negocio): se buscan en el backend con
  // LIMIT 30 y `exactId` para que el valor guardado aparezca al editar aunque caiga
  // fuera del top-30.

  async buscarEmpresas(user: any, search = '', exactId?: number) {
    // Una cuenta de portal no elige empresa: se le devuelve la suya y nada más.
    if (esUsuarioDePortal(user)) {
      const data = await this.dataSource.query(
        `SELECT e.id_empresa AS id, e.razon_social AS nombre, e.ruc
           FROM empresa e WHERE e.id_empresa = ? AND e.estado_registro = 'ACTIVO'`,
        [Number(user.idEmpresa)],
      );
      return { data };
    }

    const params: any[] = [`%${search}%`, `%${search}%`];
    let orderBy = 'ORDER BY e.razon_social ASC';
    if (exactId) {
      orderBy = 'ORDER BY CASE WHEN e.id_empresa = ? THEN 0 ELSE 1 END, e.razon_social ASC';
      params.push(exactId);
    }
    const data = await this.dataSource.query(
      `SELECT e.id_empresa AS id, e.razon_social AS nombre, e.ruc
         FROM empresa e
        WHERE e.estado_registro = 'ACTIVO' AND (e.razon_social LIKE ? OR e.ruc LIKE ?)
        ${orderBy} LIMIT 30`,
      params,
    );
    return { data };
  }

  async buscarProveedores(user: any, search = '', idEmpresa?: number, exactId?: number) {
    const empresa = empresaEfectiva(user, idEmpresa);
    const where = [`t.estado_registro = 'ACTIVO'`, 't.es_proveedor = 1', '(t.razon_social LIKE ? OR t.numero_documento LIKE ?)'];
    const params: any[] = [`%${search}%`, `%${search}%`];
    if (empresa) { where.push('t.id_empresa = ?'); params.push(empresa); }

    let orderBy = 'ORDER BY t.razon_social ASC';
    if (exactId) {
      orderBy = 'ORDER BY CASE WHEN t.id_tercero = ? THEN 0 ELSE 1 END, t.razon_social ASC';
      params.push(exactId);
    }
    const data = await this.dataSource.query(
      `SELECT t.id_tercero AS id, t.razon_social AS nombre, t.numero_documento, t.tipo_documento, t.datos_pago
         FROM tesoreria_tercero t WHERE ${where.join(' AND ')} ${orderBy} LIMIT 30`,
      params,
    );
    return { data };
  }

  async buscarPersonal(user: any, search = '', idEmpresa?: number, exactId?: number) {
    const empresa = empresaEfectiva(user, idEmpresa);
    const where = [
      `p.estado_registro = 'ACTIVO'`,
      `(CONCAT_WS(' ', p.nombres, p.apellido_paterno, p.apellido_materno) LIKE ? OR p.numero_documento LIKE ?)`,
    ];
    const params: any[] = [`%${search}%`, `%${search}%`];
    if (empresa) { where.push('p.id_empresa = ?'); params.push(empresa); }

    let orderBy = 'ORDER BY p.apellido_paterno ASC, p.nombres ASC';
    if (exactId) {
      orderBy = 'ORDER BY CASE WHEN p.id_trabajador = ? THEN 0 ELSE 1 END, p.apellido_paterno ASC';
      params.push(exactId);
    }
    const data = await this.dataSource.query(
      `SELECT p.id_trabajador AS id,
              CONCAT_WS(' ', p.nombres, p.apellido_paterno, p.apellido_materno) AS nombre,
              p.numero_documento, p.cargo
         FROM planilla_trabajador p WHERE ${where.join(' AND ')} ${orderBy} LIMIT 30`,
      params,
    );
    return { data };
  }

  /**
   * Conceptos de centro de costo de la empresa, con su ruta completa
   * (CATEGORÍA › SUBCATEGORÍA › CONCEPTO): "COMBUSTIBLE" a secas se repite en varias
   * ramas y sin la ruta no hay forma de saber cuál se está eligiendo.
   */
  async buscarConceptos(user: any, search = '', idEmpresa?: number, exactId?: number) {
    const empresa = empresaEfectiva(user, idEmpresa);
    const where = [
      `cc.estado_registro = 'ACTIVO'`, `s.estado_registro = 'ACTIVO'`, `c.estado_registro = 'ACTIVO'`,
      '(cc.nombre LIKE ? OR s.nombre LIKE ? OR c.nombre LIKE ?)',
    ];
    const params: any[] = [`%${search}%`, `%${search}%`, `%${search}%`];
    if (empresa) { where.push('c.id_empresa = ?'); params.push(empresa); }

    let orderBy = 'ORDER BY c.nombre ASC, s.nombre ASC, cc.nombre ASC';
    if (exactId) {
      orderBy = `ORDER BY CASE WHEN cc.id_centro_costo_concepto = ? THEN 0 ELSE 1 END, c.nombre ASC, s.nombre ASC, cc.nombre ASC`;
      params.push(exactId);
    }

    const data = await this.dataSource.query(
      `SELECT cc.id_centro_costo_concepto AS id, cc.nombre,
              s.nombre AS nombre_subcategoria, c.nombre AS nombre_categoria, c.id_empresa,
              CONCAT_WS(' › ', c.nombre, s.nombre, cc.nombre) AS ruta
         FROM centro_costo_concepto cc
         INNER JOIN centro_costo_subcategoria s ON s.id_centro_costo_subcategoria = cc.id_centro_costo_subcategoria
         INNER JOIN centro_costo_categoria c ON c.id_centro_costo_categoria = s.id_centro_costo_categoria
        WHERE ${where.join(' AND ')} ${orderBy} LIMIT 30`,
      params,
    );
    return { data };
  }

  /** Catálogo CERRADO y chico: se manda entero, sin búsqueda ni paginación. */
  async getMediosPago() {
    const data = await this.dataSource.query(
      `SELECT id_medio_pago AS id, nombre, codigo FROM tesoreria_medio_pago
        WHERE estado_registro = 'ACTIVO' ORDER BY orden ASC, nombre ASC`,
    );
    return { data };
  }

  // ── EXPORTACIÓN ─────────────────────────────────────────────────────────────

  private columnasExport() {
    return [
      { header: 'ID', key: 'id_requerimiento', width: 8 },
      { header: 'FECHA', key: 'fecha_registro', width: 12 },
      { header: 'EMPRESA', key: 'nombre_empresa', width: 38 },
      { header: 'PROVEEDOR', key: 'nombre_proveedor', width: 34 },
      { header: 'SOLICITANTE', key: 'nombre_solicitante', width: 28 },
      { header: 'COMPROBANTE', key: 'nro_comprobante', width: 18 },
      { header: 'ÍTEMS', key: 'total_items', width: 8 },
      { header: 'TOTAL S/', key: 'total', width: 14 },
      { header: 'TOTAL US$', key: 'total_dolares', width: 14 },
      { header: 'PRIORIDAD', key: 'prioridad', width: 12 },
      { header: 'ESTADO', key: 'estado_aprobacion', width: 14 },
    ];
  }

  async exportarExcel(query: any, res: Response, user?: any) {
    const data = (await this.findAll(query, true, user)) as any[];
    await this.excelService.generarExcel(
      this.columnasExport(), data,
      `Requerimientos_${new Date().toISOString().split('T')[0]}`, 'Requerimientos', res,
    );
  }

  async exportarPdf(query: any, res: Response, user?: any) {
    const data = (await this.findAll(query, true, user)) as any[];
    const columnas = this.columnasExport();

    const fmt = (valor: any, key: string) => {
      if (valor === null || valor === undefined || valor === '') return '—';
      if (key === 'total' || key === 'total_dolares') return num(valor).toFixed(2);
      if (key === 'fecha_registro') return new Date(valor).toLocaleDateString('es-PE');
      return String(valor);
    };

    const filas = data
      .map((item) => `<tr>${columnas.map((c) => `<td>${fmt(item[c.key], c.key)}</td>`).join('')}</tr>`)
      .join('');

    // Los totales del pie se calculan acá y no en la query: son los de las filas que de
    // verdad se están imprimiendo, con los mismos filtros que el usuario ve en pantalla.
    const totalPen = data.reduce((acc, i) => acc + num(i.total), 0);
    const totalUsd = data.reduce((acc, i) => acc + num(i.total_dolares), 0);

    const html = `
    <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <style>
        @page { margin: 25px; size: A4 landscape; }
        body { font-size: 9px; color: #1e293b; margin: 0; }
        .header { border-bottom: 3px solid #0f243e; padding-bottom: 12px; margin-bottom: 16px; }
        .header h2 { margin: 0; color: #0f243e; font-size: 18px; text-transform: uppercase; }
        .header h1 { margin: 6px 0 0; font-size: 13px; text-transform: uppercase; color: #0f243e; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #0f243e; color: #fff; padding: 8px 7px; text-align: center; font-size: 9px; text-transform: uppercase; }
        td { padding: 7px; border-bottom: 1px solid #e2e8f0; text-align: center; }
        .footer { margin-top: 16px; font-size: 7px; color: #94a3b8; text-align: center; }
        .totales { margin-top: 10px; font-size: 10px; font-weight: bold; text-align: right; color: #0f243e; }
    </style></head><body>
    <div class="header">
        <h2>Estudio Contable Barba</h2>
        <h1>Requerimientos de compra</h1>
        <p style="margin:4px 0 0">Generado el: ${new Date().toLocaleString('es-PE')} · Total: ${data.length} requerimientos</p>
    </div>
    <table>
        <thead><tr>${columnas.map((c) => `<th>${c.header}</th>`).join('')}</tr></thead>
        <tbody>${filas || `<tr><td colspan="${columnas.length}" style="padding:30px;color:#94a3b8">Sin requerimientos para los filtros aplicados</td></tr>`}</tbody>
    </table>
    <div class="totales">TOTAL S/ ${totalPen.toFixed(2)} &nbsp;·&nbsp; TOTAL US$ ${totalUsd.toFixed(2)}</div>
    <div class="footer">
        Importes con IGV incluido en las líneas que lo llevan &nbsp;·&nbsp;
        Soles y dólares nunca se suman entre sí &nbsp;·&nbsp;
        Incluye solo los requerimientos que pasan los filtros de la pantalla
    </div>
    </body></html>`;

    await this.pdfHtmlService.generarPdf(
      html, `Requerimientos_${new Date().toISOString().split('T')[0]}`, res, { landscape: true },
    );
  }
}

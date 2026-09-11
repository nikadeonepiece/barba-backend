import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditoriaService } from '@app/common';
import { RequerimientosService } from '../requerimientos/requerimientos.service';
import { resolverLinea, totalesPorMoneda, num } from '../requerimientos/requerimiento-lineas';
import { AprobarRequerimientoDto, RechazarRequerimientoDto } from '../requerimientos/dto/requerimiento.dto';

/**
 * Aprobación de requerimientos — la pantalla de FINANZAS.
 *
 * Portado de `finanzas/aprobacion-requerimientos` de Transportes Montero. Trabaja
 * sobre las mismas dos tablas que `requerimientos` y hace lo único que esa pantalla no
 * puede hacer: decidir, y convertir la decisión en plata a pagar.
 *
 * ── Qué pasa al aprobar ──
 *
 * Se genera una `tesoreria_orden_pago` con `tabla_origen = 'requerimiento'`. Desde ese
 * momento el gasto vive en tesorería y se paga con el circuito que ya existe (cuotas,
 * abonos, estado de cuenta). El requerimiento guarda el id de la orden para poder
 * volver de una a la otra.
 *
 * ── Por qué puede generar DOS órdenes ──
 *
 * `tesoreria_orden_pago.moneda` admite un solo valor. Un requerimiento que mezcla
 * ítems en soles y en dólares necesita una orden por moneda: meter todo en una
 * obligaría a convertir a un tipo de cambio que nadie fijó todavía.
 *
 * ── Por qué reusa el service de requerimientos para LEER ──
 *
 * `findOne` es exactamente la misma consulta, y dos versiones de "qué dice este
 * requerimiento" terminan mostrando distinto en cada pantalla. Lo que NO se reusa es
 * el `update`: acá finanzas toca solo montos y solo mientras está PENDIENTE.
 */
@Injectable()
export class AprobacionRequerimientosService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private readonly requerimientosService: RequerimientosService,
  ) {}

  /** La bandeja: por defecto muestra lo PENDIENTE, que es a lo que se entra. */
  findAll(query: any = {}, user?: any) {
    return this.requerimientosService.findAll(
      {
        ...query,
        estado_aprobacion: query.estado_aprobacion || 'PENDIENTE',
        sortCol: query.sortCol || 'fecha',
        sortDir: query.sortDir || 'ASC', // lo más viejo primero: es una cola, no un feed
      },
      false,
      // El `user` viaja aunque esta pantalla sea del estudio: si algún día el permiso
      // de aprobación se le da a una cuenta de portal, el scope ya está puesto y verá
      // solo lo suyo en vez de la cola de las 171 empresas.
      user,
    );
  }

  findOne(id: number, user?: any) {
    return this.requerimientosService.findOne(id, user);
  }

  /** Resumen para los contadores de la cabecera de la pantalla. */
  async resumen(idEmpresa?: number) {
    const where = [`r.estado_registro = 'ACTIVO'`];
    const params: any[] = [];
    if (idEmpresa) { where.push('r.id_empresa = ?'); params.push(idEmpresa); }
    const whereSql = where.join(' AND ');

    // Las dos consultas son independientes: van en paralelo.
    const [[conteos], [montos]] = await Promise.all([
      this.dataSource.query(
        `SELECT
           SUM(CASE WHEN r.estado_aprobacion = 'PENDIENTE' THEN 1 ELSE 0 END) AS pendientes,
           SUM(CASE WHEN r.estado_aprobacion = 'APROBADO'  THEN 1 ELSE 0 END) AS aprobados,
           SUM(CASE WHEN r.estado_aprobacion = 'RECHAZADO' THEN 1 ELSE 0 END) AS rechazados
         FROM requerimiento r WHERE ${whereSql}`,
        params,
      ),
      this.dataSource.query(
        // COALESCE porque un SUM sin filas devuelve NULL, no 0.
        `SELECT COALESCE(SUM(r.total), 0) AS monto_pendiente_pen,
                COALESCE(SUM(r.total_dolares), 0) AS monto_pendiente_usd
           FROM requerimiento r WHERE ${whereSql} AND r.estado_aprobacion = 'PENDIENTE'`,
        params,
      ),
    ]);

    return {
      pendientes: Number(conteos.pendientes) || 0,
      aprobados: Number(conteos.aprobados) || 0,
      rechazados: Number(conteos.rechazados) || 0,
      monto_pendiente_pen: num(montos.monto_pendiente_pen),
      monto_pendiente_usd: num(montos.monto_pendiente_usd),
    };
  }

  // ── APROBAR ─────────────────────────────────────────────────────────────────

  /**
   * Recalcula las líneas ajustadas por finanzas y da de baja las que quitó.
   *
   * `con_igv`, `pago_dolares` y `modo_ingreso` pueden no venir en el ajuste: finanzas
   * corrige cantidades y precios, no la naturaleza de la línea. Lo que no venga se
   * respeta como está guardado.
   */
  private async aplicarAjustes(qr: QueryRunner, id: number, ajustes: NonNullable<AprobarRequerimientoDto['detalles_ajustados']>, userId: number) {
    const actuales = await qr.query(
      `SELECT id_detalle, con_igv, pago_dolares, modo_ingreso FROM requerimiento_detalle
        WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    const porId = new Map<number, any>(actuales.map((d: any) => [Number(d.id_detalle), d]));

    const lineas: { subtotal: number; pago_dolares: number }[] = [];
    for (const ajuste of ajustes) {
      const original = porId.get(Number(ajuste.id_detalle));
      if (!original) {
        throw new BadRequestException(`El ítem #${ajuste.id_detalle} no pertenece a este requerimiento o ya fue quitado.`);
      }

      const con_igv = ajuste.con_igv !== undefined ? Number(ajuste.con_igv) : Number(original.con_igv);
      const pago_dolares = ajuste.pago_dolares !== undefined ? Number(ajuste.pago_dolares) : Number(original.pago_dolares);
      const modo_ingreso = ajuste.modo_ingreso ?? original.modo_ingreso ?? 'UNITARIO';

      const linea = resolverLinea({
        cantidad: ajuste.cantidad,
        precio_unitario: ajuste.precio_unitario,
        subtotal: ajuste.subtotal,
        con_igv,
        modo_ingreso,
      });

      await qr.query(
        `UPDATE requerimiento_detalle
            SET cantidad = ?, precio_unitario = ?, modo_ingreso = ?, con_igv = ?, pago_dolares = ?, subtotal = ?, id_usuario_mod = ?
          WHERE id_detalle = ? AND id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
        [ajuste.cantidad, linea.precio_unitario, linea.modo_ingreso, con_igv, pago_dolares, linea.subtotal, userId, ajuste.id_detalle, id],
      );

      lineas.push({ subtotal: linea.subtotal, pago_dolares });
    }

    // Lo que finanzas no mandó, se quita: es cómo se saca un ítem que no se va a pagar.
    const idsIncluidos = ajustes.map((a) => Number(a.id_detalle));
    await qr.query(
      `UPDATE requerimiento_detalle SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
        WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'
          AND id_detalle NOT IN (${idsIncluidos.map(() => '?').join(',')})`,
      [userId, id, ...idsIncluidos],
    );

    return totalesPorMoneda(lineas);
  }

  /** Descripción de la orden de pago: tiene que bastarse sola en el estado de cuenta. */
  private async armarDescripcion(qr: QueryRunner, id: number, req: any, totalPen: number, totalUsd: number) {
    const montos = totalUsd > 0 && totalPen > 0
      ? `S/ ${totalPen.toFixed(2)} + US$ ${totalUsd.toFixed(2)}`
      : totalUsd > 0 ? `US$ ${totalUsd.toFixed(2)}` : `S/ ${totalPen.toFixed(2)}`;

    const partes: string[] = [`REQUERIMIENTO #${id} — ${montos}`];

    const filas = await qr.query(
      `SELECT d.detalle, cc.nombre AS nombre_concepto
         FROM requerimiento_detalle d
         LEFT JOIN centro_costo_concepto cc ON cc.id_centro_costo_concepto = d.id_centro_costo_concepto
        WHERE d.id_requerimiento = ? AND d.estado_registro = 'ACTIVO'`,
      [id],
    );
    const conceptos = [...new Set(filas.map((f: any) => f.nombre_concepto).filter(Boolean))];
    const items = filas.map((f: any) => f.detalle).filter(Boolean);

    if (conceptos.length) partes.push(`CENTRO DE COSTO: ${conceptos.join(' / ')}`);
    if (items.length) partes.push(`ÍTEMS: ${items.join(' / ')}`);
    if (req.tipo_comprobante && req.tipo_comprobante !== 'NINGUNO' && req.nro_comprobante) {
      partes.push(`${req.tipo_comprobante}: ${req.nro_comprobante}`);
    }
    // La observación va al final: dice POR QUÉ salió el gasto, y así viaja a tesorería
    // junto con el resto del texto.
    if (req.observacion?.trim()) partes.push(`OBS: ${req.observacion.trim()}`);

    return partes.join(' | ');
  }

  async aprobar(id: number, dto: AprobarRequerimientoDto, userId: number) {
    const [req] = await this.dataSource.query(
      `SELECT * FROM requerimiento WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!req) throw new NotFoundException('El requerimiento no existe o fue dado de baja.');
    if (req.estado_aprobacion !== 'PENDIENTE') {
      throw new BadRequestException(`Este requerimiento ya fue ${req.estado_aprobacion.toLowerCase()}: no se puede volver a procesar.`);
    }

    const idProveedor = dto.id_tercero_proveedor ?? req.id_tercero_proveedor;
    if (!idProveedor) {
      throw new BadRequestException(
        'El requerimiento no tiene proveedor y la orden de pago necesita saber a quién se le paga. ' +
        'Elegí el proveedor en este mismo formulario antes de aprobar.',
      );
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const [proveedor] = await qr.query(
        `SELECT id_tercero, razon_social FROM tesoreria_tercero
          WHERE id_tercero = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
        [idProveedor, req.id_empresa],
      );
      if (!proveedor) throw new BadRequestException('El proveedor elegido no pertenece a la empresa del requerimiento.');

      let totalPen = num(req.total);
      let totalUsd = num(req.total_dolares);

      if (dto.detalles_ajustados?.length) {
        const totales = await this.aplicarAjustes(qr, id, dto.detalles_ajustados, userId);
        totalPen = totales.total;
        totalUsd = totales.total_dolares;
      }

      if (totalPen <= 0 && totalUsd <= 0) {
        throw new BadRequestException('El requerimiento quedó en cero después del ajuste: no hay nada que pagar.');
      }

      const fechaVencimiento = dto.fecha_vencimiento || req.fecha_vencimiento || req.fecha_registro;
      const tipoComprobante = dto.tipo_comprobante || req.tipo_comprobante || 'NINGUNO';
      const nroComprobante = dto.nro_comprobante?.trim() || req.nro_comprobante || null;
      const descripcion = await this.armarDescripcion(qr, id, { ...req, tipo_comprobante: tipoComprobante, nro_comprobante: nroComprobante }, totalPen, totalUsd);

      // `codigo_orden` es único por empresa. `revertir()` ANULA la orden pero NO le
      // cambia el código (queda como historial), así que una segunda aprobación del
      // mismo requerimiento chocaría contra el índice con un ER_DUP_ENTRY.
      //
      // El sufijo `-R{n}` es solo un desempatador: `n` sale de cuántas órdenes se
      // generaron antes para este requerimiento, no de cuántas veces se aprobó — un
      // requerimiento con monedas mezcladas genera dos órdenes por aprobación, así que
      // la segunda vuelta sale como `-R3`. Lo que importa es que el código no se repita;
      // el historial real de quién aprobó y cuándo está en `sis_auditoria`.
      const [{ intentos }] = await qr.query(
        `SELECT COUNT(*) AS intentos FROM tesoreria_orden_pago
          WHERE tabla_origen = 'requerimiento' AND id_registro_origen = ?`,
        [id],
      );
      const base = Number(intentos) > 0 ? `REQ-${id}-R${Number(intentos) + 1}` : `REQ-${id}`;

      const crearOrden = async (moneda: 'PEN' | 'USD', monto: number, sufijo: string) => {
        const res: any = await qr.query(
          `INSERT INTO tesoreria_orden_pago
            (id_empresa, codigo_orden, id_tercero, tipo_transaccion, tipo_documento, serie_numero,
             fecha_emision, fecha_vencimiento, moneda, monto_total, estado_orden, descripcion,
             tabla_origen, id_registro_origen, estado_registro, id_usuario_crea)
           VALUES (?, ?, ?, 'SERVICIO', ?, ?, CURDATE(), ?, ?, ?, 'PENDIENTE', ?, 'requerimiento', ?, 'ACTIVO', ?)`,
          [
            req.id_empresa, `${base}${sufijo}`, idProveedor,
            tipoComprobante === 'NINGUNO' ? 'OTRO' : tipoComprobante, nroComprobante,
            fechaVencimiento, moneda, monto, descripcion, id, userId,
          ],
        );
        return Number(res.insertId);
      };

      let idOrdenPen: number | null = null;
      let idOrdenUsd: number | null = null;
      if (totalPen > 0) idOrdenPen = await crearOrden('PEN', totalPen, totalUsd > 0 ? '-PEN' : '');
      if (totalUsd > 0) idOrdenUsd = await crearOrden('USD', totalUsd, totalPen > 0 ? '-USD' : '');

      // La "principal" es la de soles cuando existe; la secundaria solo se llena si
      // hubo mezcla de monedas.
      const idOrdenPrincipal = idOrdenPen ?? idOrdenUsd!;
      const idOrdenSecundaria = idOrdenPen && idOrdenUsd ? idOrdenUsd : null;

      const res: any = await qr.query(
        `UPDATE requerimiento
            SET estado_aprobacion = 'APROBADO', id_usuario_aprueba = ?, fecha_aprobacion = NOW(),
                id_tercero_proveedor = ?, fecha_vencimiento = ?, tipo_comprobante = ?, nro_comprobante = ?,
                total = ?, total_dolares = ?,
                id_orden_pago = ?, id_orden_pago_dolares = ?, motivo_rechazo = NULL, id_usuario_mod = ?
          WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO' AND estado_aprobacion = 'PENDIENTE'`,
        [
          userId, idProveedor, fechaVencimiento, tipoComprobante, nroComprobante,
          totalPen, totalUsd, idOrdenPrincipal, idOrdenSecundaria, userId, id,
        ],
      );
      // Candado contra la doble aprobación simultánea: si otro usuario aprobó entre la
      // lectura y este UPDATE, acá no se actualiza nada y la transacción entera se va
      // atrás — incluidas las órdenes recién insertadas.
      if (res.affectedRows === 0) {
        throw new ConflictException('Otro usuario procesó este requerimiento mientras lo aprobabas. Volvé a abrir la bandeja.');
      }

      await this.auditoriaService.registrarConTransaccion(
        qr, 'requerimiento', id, 'ACTUALIZAR', userId, req,
        { estado_aprobacion: 'APROBADO', total: totalPen, total_dolares: totalUsd, id_orden_pago: idOrdenPrincipal, id_orden_pago_dolares: idOrdenSecundaria },
      );

      await qr.commitTransaction();
      return {
        id_orden_pago: idOrdenPrincipal,
        id_orden_pago_dolares: idOrdenSecundaria,
        mensaje: idOrdenSecundaria
          ? 'Requerimiento aprobado. Se generaron dos órdenes de pago (una en soles y una en dólares).'
          : 'Requerimiento aprobado y orden de pago generada.',
      };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  // ── RECHAZAR ────────────────────────────────────────────────────────────────

  async rechazar(id: number, dto: RechazarRequerimientoDto, userId: number) {
    const [req] = await this.dataSource.query(
      `SELECT * FROM requerimiento WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!req) throw new NotFoundException('El requerimiento no existe o fue dado de baja.');
    if (req.estado_aprobacion !== 'PENDIENTE') {
      throw new BadRequestException(`Este requerimiento ya fue ${req.estado_aprobacion.toLowerCase()}: no se puede rechazar.`);
    }

    const motivo = dto.motivo_rechazo.trim();
    if (!motivo) throw new BadRequestException('El motivo del rechazo es obligatorio.');

    const res: any = await this.dataSource.query(
      `UPDATE requerimiento
          SET estado_aprobacion = 'RECHAZADO', motivo_rechazo = ?, id_usuario_aprueba = ?,
              fecha_aprobacion = NOW(), id_usuario_mod = ?
        WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO' AND estado_aprobacion = 'PENDIENTE'`,
      [motivo, userId, userId, id],
    );
    if (res.affectedRows === 0) {
      throw new ConflictException('Otro usuario procesó este requerimiento mientras lo rechazabas. Volvé a abrir la bandeja.');
    }

    await this.auditoriaService.registrar(
      'requerimiento', id, 'ACTUALIZAR', userId, req, { estado_aprobacion: 'RECHAZADO', motivo_rechazo: motivo },
    );
    return { mensaje: 'Requerimiento rechazado. Quien lo pidió ve el motivo en el listado.' };
  }

  // ── REVERTIR ────────────────────────────────────────────────────────────────

  /**
   * Devuelve un requerimiento aprobado a PENDIENTE y anula sus órdenes de pago.
   *
   * Solo si NINGUNA de las órdenes recibió un abono: con plata ya pagada, anular la
   * orden dejaría el abono colgado de un documento anulado y el estado de cuenta del
   * proveedor sin cuadrar. En ese caso la salida es una nota de crédito o un ajuste en
   * tesorería, no revertir acá.
   */
  async revertir(id: number, userId: number) {
    const [req] = await this.dataSource.query(
      `SELECT * FROM requerimiento WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!req) throw new NotFoundException('El requerimiento no existe o fue dado de baja.');
    if (req.estado_aprobacion !== 'APROBADO') {
      throw new BadRequestException('Solo se puede revertir un requerimiento APROBADO.');
    }

    const idsOrden = [req.id_orden_pago, req.id_orden_pago_dolares].filter(Boolean) as number[];
    if (!idsOrden.length) {
      throw new BadRequestException('El requerimiento está aprobado pero no tiene orden de pago asociada. Revisalo en tesorería antes de tocarlo.');
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const [{ abonos }] = await qr.query(
        `SELECT COUNT(*) AS abonos FROM tesoreria_orden_pago_abono
          WHERE id_orden_pago IN (${idsOrden.map(() => '?').join(',')}) AND estado_registro = 'ACTIVO'`,
        idsOrden,
      );
      if (Number(abonos) > 0) {
        throw new ConflictException(
          'La orden de pago de este requerimiento ya tiene pagos registrados, así que no se puede revertir. ' +
          'Si el gasto cambió, corregilo en tesorería sobre la orden.',
        );
      }

      await qr.query(
        `UPDATE tesoreria_orden_pago
            SET estado_orden = 'ANULADA', motivo_anulacion = ?, id_usuario_mod = ?
          WHERE id_orden_pago IN (${idsOrden.map(() => '?').join(',')}) AND estado_registro = 'ACTIVO'`,
        [`Aprobación revertida del requerimiento #${id}`, userId, ...idsOrden],
      );

      const res: any = await qr.query(
        `UPDATE requerimiento
            SET estado_aprobacion = 'PENDIENTE', id_usuario_aprueba = NULL, fecha_aprobacion = NULL,
                id_orden_pago = NULL, id_orden_pago_dolares = NULL, id_usuario_mod = ?
          WHERE id_requerimiento = ? AND estado_registro = 'ACTIVO' AND estado_aprobacion = 'APROBADO'`,
        [userId, id],
      );
      if (res.affectedRows === 0) {
        throw new ConflictException('El requerimiento cambió de estado mientras lo revertías. Volvé a abrir la bandeja.');
      }

      await this.auditoriaService.registrarConTransaccion(
        qr, 'requerimiento', id, 'ACTUALIZAR', userId, req, { estado_aprobacion: 'PENDIENTE', ordenes_anuladas: idsOrden },
      );

      await qr.commitTransaction();
      return { mensaje: 'Aprobación revertida. La orden de pago quedó anulada y el requerimiento volvió a PENDIENTE.' };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }
}

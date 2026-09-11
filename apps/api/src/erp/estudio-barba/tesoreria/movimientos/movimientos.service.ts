import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { AuditoriaService, ExcelService, PdfHtmlService } from '@app/common';
import { RequerimientosArchivoService } from '../../../clientes-planillas/requerimientos/requerimientos-archivo.service';
import {
  bloquearCuenta, recalcularSaldosCuenta, validarMoneda, num, money,
} from './cuentas-saldos';
import {
  CreateMovimientoDto, UpdateMovimientoDto, TransferenciaDto, AnularMovimientoDto,
} from './dto/movimiento.dto';

/** `ORDER BY` dinámico: la columna sale de esta whitelist, nunca del query string. */
const COLS_ORDER: Record<string, string> = {
  fecha: 'm.fecha',
  id: 'm.id_movimiento',
  monto: 'm.monto',
  empresa: 'e.razon_social',
  cuenta: 'cu.alias',
  tercero: 't.razon_social',
};

/** Marca los dos movimientos que nacen de una transferencia entre cuentas propias. */
export const ORIGEN_TRANSFERENCIA = 'transferencia_interna';

/**
 * Movimientos de tesorería — el libro de plata de las cuentas bancarias.
 *
 * Portado de `finanzas/movimientos` de Transportes Montero. Lo que cambió al traerlo:
 *
 * · **Sin rubro ni plan contable**: acá las empresas son clientes del estudio (no un
 *   grupo con rubros) y no hay tabla de plan contable.
 * · **`tipo_operacion` → centro de costo**: la dimensión de análisis de Montero se
 *   reemplaza por el árbol de `centro_costo_concepto`, que es el que este ERP ya tiene
 *   y el mismo que usan los requerimientos. Así la plata pedida y la plata movida se
 *   pueden cruzar por el mismo catálogo.
 * · **El tipo (INGRESO/EGRESO) es del movimiento**, no se deduce del catálogo de
 *   operación como en Montero.
 *
 * Lo que se conserva igual: el ciclo de conciliación (`estado_flujo`), la
 * transferencia entre cuentas como par de movimientos atados, la anulación con motivo
 * en vez de borrar, y los filtros de la pantalla.
 */
@Injectable()
export class MovimientosService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private readonly archivoService: RequerimientosArchivoService,
    private readonly excelService: ExcelService,
    private readonly pdfHtmlService: PdfHtmlService,
  ) {}

  // ── LISTADO ─────────────────────────────────────────────────────────────────

  private filtros(query: any) {
    const where: string[] = [`m.estado_registro = 'ACTIVO'`];
    const params: any[] = [];

    // Por defecto NO se muestran los anulados: ensucian el listado y el usuario los
    // busca solo cuando quiere entender qué pasó con uno.
    if (query.estado) { where.push('m.estado = ?'); params.push(query.estado); }
    else { where.push(`m.estado = 'REGISTRADO'`); }

    if (query.id_empresa) { where.push('m.id_empresa = ?'); params.push(Number(query.id_empresa)); }
    if (query.id_cuenta) { where.push('m.id_cuenta = ?'); params.push(Number(query.id_cuenta)); }
    if (query.id_banco) { where.push('cu.id_banco = ?'); params.push(Number(query.id_banco)); }
    if (query.id_tercero) { where.push('m.id_tercero = ?'); params.push(Number(query.id_tercero)); }
    if (query.id_medio_pago) { where.push('m.id_medio_pago = ?'); params.push(Number(query.id_medio_pago)); }
    if (query.id_centro_costo_concepto) { where.push('m.id_centro_costo_concepto = ?'); params.push(Number(query.id_centro_costo_concepto)); }
    if (query.tipo) { where.push('m.tipo = ?'); params.push(query.tipo); }
    if (query.estado_flujo) { where.push('m.estado_flujo = ?'); params.push(query.estado_flujo); }

    if (query.fecha_desde) { where.push('m.fecha >= ?'); params.push(query.fecha_desde); }
    // `fecha` es DATE, no DATETIME: acá `<=` no pierde el último día.
    if (query.fecha_hasta) { where.push('m.fecha <= ?'); params.push(query.fecha_hasta); }

    if (query.search) {
      const like = `%${String(query.search).trim()}%`;
      where.push(`(m.descripcion LIKE ? OR m.serie_numero LIKE ? OR e.razon_social LIKE ?
                   OR cu.alias LIKE ? OR cu.numero_cuenta LIKE ? OR b.nombre LIKE ?
                   OR t.razon_social LIKE ? OR cc.nombre LIKE ?)`);
      params.push(like, like, like, like, like, like, like, like);
    }

    return { whereSql: where.join(' AND '), params };
  }

  private readonly JOINS = `
    FROM tesoreria_movimiento m
    INNER JOIN empresa e ON e.id_empresa = m.id_empresa
    INNER JOIN tesoreria_cuenta cu ON cu.id_cuenta = m.id_cuenta
    LEFT JOIN planilla_banco b ON b.id_banco = cu.id_banco AND b.estado_registro = 'ACTIVO'
    LEFT JOIN tesoreria_tercero t ON t.id_tercero = m.id_tercero
    LEFT JOIN tesoreria_medio_pago mp ON mp.id_medio_pago = m.id_medio_pago AND mp.estado_registro = 'ACTIVO'
    LEFT JOIN centro_costo_concepto cc ON cc.id_centro_costo_concepto = m.id_centro_costo_concepto
    LEFT JOIN centro_costo_subcategoria s ON s.id_centro_costo_subcategoria = cc.id_centro_costo_subcategoria
    LEFT JOIN centro_costo_categoria ca ON ca.id_centro_costo_categoria = s.id_centro_costo_categoria
  `;

  private readonly COLS = `
    m.id_movimiento, m.id_empresa, m.id_cuenta, m.id_tercero, m.id_medio_pago,
    m.id_centro_costo_concepto, m.tipo, m.fecha, m.monto, m.moneda, m.tipo_cambio,
    m.saldo_anterior, m.saldo_posterior, m.descripcion,
    m.tipo_comprobante, m.serie_numero, m.ruta_comprobante,
    m.tabla_origen, m.id_registro_origen, m.id_movimiento_relacionado,
    m.estado, m.estado_flujo, m.motivo_anulacion,
    e.razon_social AS nombre_empresa,
    cu.alias AS alias_cuenta, cu.numero_cuenta, cu.moneda AS moneda_cuenta, cu.tipo AS tipo_cuenta,
    b.nombre AS nombre_banco,
    t.razon_social AS nombre_tercero, t.numero_documento AS doc_tercero,
    mp.nombre AS nombre_medio_pago,
    cc.nombre AS nombre_concepto,
    CONCAT_WS(' › ', ca.nombre, s.nombre, cc.nombre) AS ruta_concepto
  `;

  private aNumeros(f: any) {
    return {
      ...f,
      monto: num(f.monto),
      tipo_cambio: f.tipo_cambio === null ? null : num(f.tipo_cambio),
      saldo_anterior: f.saldo_anterior === null ? null : num(f.saldo_anterior),
      saldo_posterior: f.saldo_posterior === null ? null : num(f.saldo_posterior),
    };
  }

  async findAll(query: any = {}, isExport = false) {
    const page = isExport ? 1 : Number(query.page) || 1;
    const limit = isExport ? 5000 : Number(query.limit) || 20;
    const offset = (page - 1) * limit;
    const { whereSql, params } = this.filtros(query);

    const col = COLS_ORDER[query.sortCol] ?? 'm.fecha';
    const dir = query.sortDir === 'ASC' ? 'ASC' : 'DESC';

    // El desempate por id es obligatorio: varias filas comparten fecha y sin él el
    // orden entre páginas cambia de una consulta a otra y se repiten o se pierden filas.
    const sqlData = `
      SELECT ${this.COLS}
      ${this.JOINS}
      WHERE ${whereSql}
      ORDER BY ${col} ${dir}, m.id_movimiento ${dir}
      LIMIT ? OFFSET ?`;

    if (isExport) {
      const filas = await this.dataSource.query(sqlData, [...params, limit, offset]);
      return filas.map((f: any) => this.aNumeros(f));
    }

    // Los totales del pie salen de los MISMOS filtros que la lista: si se calcularan
    // sobre la página se contradirían con el "Total" que el usuario espera.
    const [data, [{ total }], [totales]] = await Promise.all([
      this.dataSource.query(sqlData, [...params, limit, offset]),
      this.dataSource.query(`SELECT COUNT(*) AS total ${this.JOINS} WHERE ${whereSql}`, params),
      this.dataSource.query(
        `SELECT
           COALESCE(SUM(CASE WHEN m.tipo = 'INGRESO' AND ${cuentaParaSaldoAlias('m')} THEN m.monto ELSE 0 END), 0) AS ingresos,
           COALESCE(SUM(CASE WHEN m.tipo = 'EGRESO'  AND ${cuentaParaSaldoAlias('m')} THEN m.monto ELSE 0 END), 0) AS egresos
         ${this.JOINS} WHERE ${whereSql}`,
        params,
      ),
    ]);

    const ingresos = num(totales?.ingresos);
    const egresos = num(totales?.egresos);

    return {
      data: data.map((f: any) => this.aNumeros(f)),
      meta: { total: Number(total), page, limit },
      // `neto` es la diferencia de lo FILTRADO, no el saldo de ninguna cuenta: un
      // filtro por mes no dice cuánto hay en el banco, dice cuánto se movió ese mes.
      totales: { ingresos, egresos, neto: Math.round((ingresos - egresos) * 100) / 100 },
    };
  }

  async findOne(id: number) {
    const [mov] = await this.dataSource.query(
      `SELECT ${this.COLS},
              CONCAT_WS(' ', u.nombres, u.apellidos) AS usuario_registra
       ${this.JOINS}
       LEFT JOIN sis_usuario u ON u.id_usuario = m.id_usuario_crea
       WHERE m.id_movimiento = ? AND m.estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!mov) throw new NotFoundException('El movimiento no existe o fue dado de baja.');

    // Si es media transferencia, se trae la otra pata para poder mostrarla.
    let contraparte: any = null;
    if (mov.id_movimiento_relacionado) {
      const [otro] = await this.dataSource.query(
        `SELECT m.id_movimiento, m.tipo, m.monto, m.moneda, cu.alias AS alias_cuenta, cu.numero_cuenta
           FROM tesoreria_movimiento m
           INNER JOIN tesoreria_cuenta cu ON cu.id_cuenta = m.id_cuenta
          WHERE m.id_movimiento = ?`,
        [mov.id_movimiento_relacionado],
      );
      contraparte = otro ? { ...otro, monto: num(otro.monto) } : null;
    }

    return { ...this.aNumeros(mov), contraparte };
  }

  // ── VALIDACIONES COMPARTIDAS ────────────────────────────────────────────────

  /**
   * Todo lo que el movimiento referencia tiene que ser de la MISMA empresa que la
   * cuenta. Sin esto, el formulario podría mandar el tercero de una empresa con la
   * cuenta de otra: los dos IDs existen, el INSERT pasa, y el error aparece cuando el
   * estado de cuenta del proveedor no cuadra.
   */
  private async validarReferencias(qr: QueryRunner, idEmpresa: number, dto: any) {
    if (dto.id_tercero) {
      const [tercero] = await qr.query(
        `SELECT id_tercero FROM tesoreria_tercero
          WHERE id_tercero = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
        [dto.id_tercero, idEmpresa],
      );
      if (!tercero) throw new BadRequestException('El tercero elegido no pertenece a la empresa de la cuenta.');
    }

    if (dto.id_medio_pago) {
      const [mp] = await qr.query(
        `SELECT id_medio_pago FROM tesoreria_medio_pago WHERE id_medio_pago = ? AND estado_registro = 'ACTIVO'`,
        [dto.id_medio_pago],
      );
      if (!mp) throw new BadRequestException('El medio de pago elegido no existe.');
    }

    if (dto.id_centro_costo_concepto) {
      const [cc] = await qr.query(
        `SELECT cc.id_centro_costo_concepto
           FROM centro_costo_concepto cc
           INNER JOIN centro_costo_subcategoria s ON s.id_centro_costo_subcategoria = cc.id_centro_costo_subcategoria
           INNER JOIN centro_costo_categoria ca ON ca.id_centro_costo_categoria = s.id_centro_costo_categoria
          WHERE cc.id_centro_costo_concepto = ? AND ca.id_empresa = ?
            AND cc.estado_registro = 'ACTIVO' AND s.estado_registro = 'ACTIVO' AND ca.estado_registro = 'ACTIVO'`,
        [dto.id_centro_costo_concepto, idEmpresa],
      );
      if (!cc) throw new BadRequestException('El centro de costo elegido no pertenece a la empresa de la cuenta.');
    }
  }

  /**
   * Un movimiento generado por otro módulo no se edita ni se anula desde acá.
   *
   * El abono de una orden de pago, por ejemplo, existe porque hay un abono del otro
   * lado: borrarlo desde el libro dejaría la orden diciendo que está pagada y la
   * cuenta diciendo que esa plata nunca salió. La corrección va en el módulo que lo
   * creó. La transferencia SÍ se puede tocar, pero por su propio camino (las dos patas
   * juntas).
   */
  private validarNoEsDeOtroModulo(mov: any, accion: string) {
    if (mov.tabla_origen && mov.tabla_origen !== ORIGEN_TRANSFERENCIA) {
      throw new BadRequestException(
        `Este movimiento lo generó otro módulo (${mov.tabla_origen}) y no se puede ${accion} desde el libro de tesorería. ` +
        'Corregilo donde se originó para que las dos puntas queden iguales.',
      );
    }
  }

  // ── ALTA ────────────────────────────────────────────────────────────────────

  async create(dto: CreateMovimientoDto, userId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const cuenta = await bloquearCuenta(qr, dto.id_cuenta);
      const moneda = dto.moneda || cuenta.moneda;
      validarMoneda(moneda, cuenta.moneda, dto.tipo_cambio);
      await this.validarReferencias(qr, cuenta.id_empresa, dto);

      const res: any = await qr.query(
        `INSERT INTO tesoreria_movimiento
          (id_empresa, id_cuenta, id_tercero, id_medio_pago, id_centro_costo_concepto,
           tipo, fecha, monto, moneda, tipo_cambio, descripcion,
           tipo_comprobante, serie_numero, ruta_comprobante,
           estado, estado_flujo, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTRADO', ?, 'ACTIVO', ?)`,
        [
          cuenta.id_empresa, dto.id_cuenta, dto.id_tercero || null, dto.id_medio_pago || null,
          dto.id_centro_costo_concepto || null,
          dto.tipo, dto.fecha, dto.monto, moneda, dto.tipo_cambio || null,
          dto.descripcion?.trim() || null,
          dto.tipo_comprobante?.trim() || null, dto.serie_numero?.trim() || null,
          dto.ruta_comprobante || null,
          dto.estado_flujo || 'PENDIENTE', userId,
        ],
      );
      const idMovimiento = Number(res.insertId);

      // `saldo_anterior`/`saldo_posterior` no se calculan en el INSERT: los pone el
      // recálculo, que es el único que conoce la posición real de este movimiento en
      // la cadena una vez ordenada por fecha.
      const { saldo } = await recalcularSaldosCuenta(qr, dto.id_cuenta, userId);

      await this.auditoriaService.registrarConTransaccion(
        qr, 'tesoreria_movimiento', idMovimiento, 'CREAR', userId, null, { ...dto, moneda },
      );

      await qr.commitTransaction();
      return { id: idMovimiento, saldo_actual: saldo, mensaje: 'Movimiento registrado correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      // La subida es un paso aparte del guardado: si el INSERT falla, el archivo ya
      // está en disco y sin esto queda huérfano.
      this.archivoService.borrarSiExiste(dto.ruta_comprobante);
      throw error;
    } finally {
      // SIEMPRE en `finally`: sin esto, una excepción agota el pool de conexiones.
      await qr.release();
    }
  }

  // ── EDICIÓN ─────────────────────────────────────────────────────────────────

  async update(id: number, dto: UpdateMovimientoDto, userId: number) {
    const [actual] = await this.dataSource.query(
      `SELECT * FROM tesoreria_movimiento WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!actual) throw new NotFoundException('El movimiento no existe o fue dado de baja.');
    if (actual.estado === 'ANULADO') {
      throw new BadRequestException('Este movimiento está anulado: no se puede editar. Registrá uno nuevo.');
    }
    this.validarNoEsDeOtroModulo(actual, 'editar');
    if (actual.id_movimiento_relacionado) {
      throw new BadRequestException(
        'Este movimiento es una de las dos patas de una transferencia. Editalo desde "Editar transferencia" ' +
        'para que las dos cuentas queden con el mismo monto y la misma fecha.',
      );
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const idCuentaNueva = dto.id_cuenta ?? actual.id_cuenta;
      // Se bloquean las DOS cuentas cuando el movimiento cambia de cuenta: las dos
      // cambian de saldo y las dos tienen que estar tomadas antes de tocar ninguna.
      const cuentaNueva = await bloquearCuenta(qr, idCuentaNueva);
      const cuentaVieja = Number(actual.id_cuenta) === Number(idCuentaNueva)
        ? cuentaNueva
        : await bloquearCuenta(qr, actual.id_cuenta);

      const moneda = dto.moneda || actual.moneda;
      validarMoneda(moneda, cuentaNueva.moneda, dto.tipo_cambio ?? actual.tipo_cambio);
      await this.validarReferencias(qr, cuentaNueva.id_empresa, { ...actual, ...dto });

      const res: any = await qr.query(
        `UPDATE tesoreria_movimiento
            SET id_empresa = ?, id_cuenta = ?, id_tercero = ?, id_medio_pago = ?, id_centro_costo_concepto = ?,
                tipo = ?, fecha = ?, monto = ?, moneda = ?, tipo_cambio = ?, descripcion = ?,
                tipo_comprobante = ?, serie_numero = ?, estado_flujo = ?, id_usuario_mod = ?
          WHERE id_movimiento = ? AND estado_registro = 'ACTIVO' AND estado = 'REGISTRADO'`,
        [
          cuentaNueva.id_empresa, idCuentaNueva,
          dto.id_tercero ?? actual.id_tercero, dto.id_medio_pago ?? actual.id_medio_pago,
          dto.id_centro_costo_concepto ?? actual.id_centro_costo_concepto,
          dto.tipo ?? actual.tipo, dto.fecha ?? actual.fecha, dto.monto ?? actual.monto,
          moneda, dto.tipo_cambio ?? actual.tipo_cambio,
          dto.descripcion?.trim() ?? actual.descripcion,
          dto.tipo_comprobante?.trim() ?? actual.tipo_comprobante,
          dto.serie_numero?.trim() ?? actual.serie_numero,
          dto.estado_flujo ?? actual.estado_flujo,
          userId, id,
        ],
      );
      if (res.affectedRows === 0) {
        throw new ConflictException('El movimiento cambió de estado mientras lo editabas. Volvé a abrirlo.');
      }

      // Se recalculan las dos cuentas si el movimiento se mudó de una a otra.
      const { saldo } = await recalcularSaldosCuenta(qr, idCuentaNueva, userId);
      if (Number(cuentaVieja.id_cuenta) !== Number(idCuentaNueva)) {
        await recalcularSaldosCuenta(qr, cuentaVieja.id_cuenta, userId);
      }

      await this.auditoriaService.registrarConTransaccion(
        qr, 'tesoreria_movimiento', id, 'ACTUALIZAR', userId, actual, dto,
      );

      await qr.commitTransaction();
      return { saldo_actual: saldo, mensaje: 'Movimiento actualizado correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  // ── ANULAR ──────────────────────────────────────────────────────────────────

  /**
   * Anular, nunca borrar: el saldo de ese día ya se reportó con el movimiento adentro,
   * y quien revise el libro tiene que poder ver que existió y por qué se cayó.
   *
   * Anular media transferencia anula las dos patas: dejar una sola viva haría aparecer
   * plata en una cuenta sin que salga de ninguna.
   */
  async anular(id: number, dto: AnularMovimientoDto, userId: number) {
    const [actual] = await this.dataSource.query(
      `SELECT * FROM tesoreria_movimiento WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!actual) throw new NotFoundException('El movimiento no existe o fue dado de baja.');
    if (actual.estado === 'ANULADO') throw new BadRequestException('Este movimiento ya está anulado.');
    this.validarNoEsDeOtroModulo(actual, 'anular');

    const motivo = dto.motivo_anulacion.trim();
    if (!motivo) throw new BadRequestException('El motivo de la anulación es obligatorio.');

    const ids = [id];
    if (actual.id_movimiento_relacionado) ids.push(Number(actual.id_movimiento_relacionado));

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // Las cuentas afectadas, bloqueadas antes de tocar nada.
      const cuentas: number[] = [];
      for (const idMov of ids) {
        const [mov] = await qr.query(`SELECT id_cuenta FROM tesoreria_movimiento WHERE id_movimiento = ?`, [idMov]);
        if (mov && !cuentas.includes(Number(mov.id_cuenta))) cuentas.push(Number(mov.id_cuenta));
      }
      for (const idCuenta of cuentas) await bloquearCuenta(qr, idCuenta);

      const res: any = await qr.query(
        `UPDATE tesoreria_movimiento
            SET estado = 'ANULADO', motivo_anulacion = ?, id_usuario_anula = ?, id_usuario_mod = ?
          WHERE id_movimiento IN (${ids.map(() => '?').join(',')})
            AND estado = 'REGISTRADO' AND estado_registro = 'ACTIVO'`,
        [motivo, userId, userId, ...ids],
      );
      if (res.affectedRows === 0) {
        throw new ConflictException('El movimiento cambió de estado mientras lo anulabas. Volvé a abrir el listado.');
      }

      for (const idCuenta of cuentas) await recalcularSaldosCuenta(qr, idCuenta, userId);

      await this.auditoriaService.registrarConTransaccion(
        qr, 'tesoreria_movimiento', id, 'ANULAR', userId, actual, null,
      );

      await qr.commitTransaction();
      return {
        mensaje: ids.length > 1
          ? 'Transferencia anulada: se revirtieron los movimientos de las dos cuentas.'
          : 'Movimiento anulado correctamente.',
      };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  // ── CONCILIACIÓN ────────────────────────────────────────────────────────────

  /**
   * Avanza (o retrocede) el estado de conciliación. Es lo único que se puede cambiar
   * de un movimiento generado por otro módulo: conciliar no toca plata, solo dice que
   * alguien lo cruzó contra el extracto del banco.
   */
  async cambiarEstadoFlujo(id: number, estadoFlujo: string, userId: number) {
    const [actual] = await this.dataSource.query(
      `SELECT id_movimiento, estado, estado_flujo FROM tesoreria_movimiento
        WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!actual) throw new NotFoundException('El movimiento no existe o fue dado de baja.');
    if (actual.estado === 'ANULADO') {
      throw new BadRequestException('Un movimiento anulado no se concilia: no existe para el banco.');
    }
    if (actual.estado_flujo === estadoFlujo) {
      throw new BadRequestException(`El movimiento ya está en ${estadoFlujo}.`);
    }

    const res: any = await this.dataSource.query(
      `UPDATE tesoreria_movimiento SET estado_flujo = ?, id_usuario_mod = ?
        WHERE id_movimiento = ? AND estado_registro = 'ACTIVO' AND estado = 'REGISTRADO'`,
      [estadoFlujo, userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('El movimiento no existe o fue anulado.');

    await this.auditoriaService.registrar(
      'tesoreria_movimiento', id, 'ACTUALIZAR', userId,
      { estado_flujo: actual.estado_flujo }, { estado_flujo: estadoFlujo },
    );
    return { mensaje: `Movimiento marcado como ${estadoFlujo.replace('_', ' ').toLowerCase()}.` };
  }

  // ── TRANSFERENCIA ENTRE CUENTAS ─────────────────────────────────────────────

  /**
   * Mueve plata entre dos cuentas propias creando DOS movimientos atados.
   *
   * No es un movimiento con dos cuentas: la plata sale de un saldo y entra en otro, y
   * cada cuenta necesita su propia fila para que su estado de cuenta cierre. Los dos se
   * apuntan con `id_movimiento_relacionado` para poder anularlos juntos.
   *
   * Nace CONCILIADO: no hay nada que cruzar con el banco desde el lado del ERP — las
   * dos puntas son nuestras y el monto es el mismo por construcción.
   */
  async transferir(dto: TransferenciaDto, userId: number) {
    if (Number(dto.id_cuenta_origen) === Number(dto.id_cuenta_destino)) {
      throw new BadRequestException('La cuenta de origen y la de destino no pueden ser la misma.');
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // SIEMPRE en el mismo orden (por id): si dos transferencias cruzadas bloquearan
      // las cuentas en orden distinto, se trabarían mutuamente (deadlock).
      const [idPrimera, idSegunda] = [Number(dto.id_cuenta_origen), Number(dto.id_cuenta_destino)].sort((a, b) => a - b);
      await bloquearCuenta(qr, idPrimera);
      await bloquearCuenta(qr, idSegunda);

      const [origen] = await qr.query(`SELECT * FROM tesoreria_cuenta WHERE id_cuenta = ?`, [dto.id_cuenta_origen]);
      const [destino] = await qr.query(`SELECT * FROM tesoreria_cuenta WHERE id_cuenta = ?`, [dto.id_cuenta_destino]);
      if (!origen || !destino) throw new NotFoundException('Alguna de las cuentas no existe o fue dada de baja.');

      if (origen.moneda !== destino.moneda && !dto.tipo_cambio) {
        throw new BadRequestException(
          `La cuenta de origen es en ${origen.moneda} y la de destino en ${destino.moneda}: ` +
          'indicá el tipo de cambio y cuánto entró realmente en la cuenta destino.',
        );
      }

      // Cuánto entra en destino: el mismo monto si comparten moneda; si no, lo que el
      // usuario declara que entró (el banco redondea a su manera) o la conversión.
      const montoDestino = origen.moneda === destino.moneda
        ? dto.monto
        : (dto.monto_destino ?? Math.round(dto.monto * Number(dto.tipo_cambio) * 100) / 100);

      const descripcion = dto.descripcion?.trim()
        || `Transferencia ${origen.alias} → ${destino.alias}`;

      const insertar = async (
        cuenta: any, tipo: 'INGRESO' | 'EGRESO', monto: number,
      ) => {
        const res: any = await qr.query(
          `INSERT INTO tesoreria_movimiento
            (id_empresa, id_cuenta, id_medio_pago, tipo, fecha, monto, moneda, tipo_cambio,
             descripcion, tabla_origen, estado, estado_flujo, estado_registro, id_usuario_crea)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTRADO', 'CONCILIADO', 'ACTIVO', ?)`,
          [
            cuenta.id_empresa, cuenta.id_cuenta, dto.id_medio_pago || null, tipo,
            dto.fecha, monto, cuenta.moneda, dto.tipo_cambio || null,
            descripcion, ORIGEN_TRANSFERENCIA, userId,
          ],
        );
        return Number(res.insertId);
      };

      const idEgreso = await insertar(origen, 'EGRESO', dto.monto);
      const idIngreso = await insertar(destino, 'INGRESO', montoDestino);

      // Se apuntan mutuamente recién ahora: hasta que no existen las dos filas no hay
      // id que guardar.
      await qr.query(
        `UPDATE tesoreria_movimiento SET id_movimiento_relacionado = ?, id_registro_origen = ? WHERE id_movimiento = ?`,
        [idIngreso, idIngreso, idEgreso],
      );
      await qr.query(
        `UPDATE tesoreria_movimiento SET id_movimiento_relacionado = ?, id_registro_origen = ? WHERE id_movimiento = ?`,
        [idEgreso, idEgreso, idIngreso],
      );

      const { saldo: saldoOrigen } = await recalcularSaldosCuenta(qr, origen.id_cuenta, userId);
      const { saldo: saldoDestino } = await recalcularSaldosCuenta(qr, destino.id_cuenta, userId);

      await this.auditoriaService.registrarConTransaccion(
        qr, 'tesoreria_movimiento', idEgreso, 'CREAR', userId, null,
        { ...dto, id_movimiento_egreso: idEgreso, id_movimiento_ingreso: idIngreso },
      );

      await qr.commitTransaction();
      return {
        id_movimiento_egreso: idEgreso,
        id_movimiento_ingreso: idIngreso,
        saldo_origen: saldoOrigen,
        saldo_destino: saldoDestino,
        mensaje: `Transferencia registrada: ${money(dto.monto, origen.moneda)} de ${origen.alias} a ${destino.alias}.`,
      };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  // ── COMPROBANTE ADJUNTO ─────────────────────────────────────────────────────

  async guardarComprobante(id: number, archivo: any, userId: number) {
    if (!archivo) throw new BadRequestException('No llegó ningún archivo.');

    const [actual] = await this.dataSource.query(
      `SELECT ruta_comprobante FROM tesoreria_movimiento
        WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!actual) {
      this.archivoService.borrarSiExiste(archivo.filename);
      throw new NotFoundException('El movimiento no existe o fue dado de baja.');
    }

    const rutaNueva = `/requerimiento-comprobantes/${archivo.filename}`;
    const res: any = await this.dataSource.query(
      `UPDATE tesoreria_movimiento SET ruta_comprobante = ?, id_usuario_mod = ?
        WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
      [rutaNueva, userId, id],
    );
    if (res.affectedRows === 0) {
      this.archivoService.borrarSiExiste(rutaNueva);
      throw new NotFoundException('El movimiento no existe o fue dado de baja.');
    }

    // Recién ahora se borra el anterior: si se borrara antes y el UPDATE fallara, el
    // registro quedaría apuntando a un archivo inexistente.
    if (actual.ruta_comprobante) this.archivoService.borrarSiExiste(actual.ruta_comprobante);

    await this.auditoriaService.registrar(
      'tesoreria_movimiento', id, 'ACTUALIZAR', userId,
      { ruta_comprobante: actual.ruta_comprobante }, { ruta_comprobante: rutaNueva },
    );
    return { ruta_comprobante: rutaNueva, mensaje: 'Comprobante adjuntado correctamente' };
  }

  async verComprobante(id: number, res: Response) {
    const [row] = await this.dataSource.query(
      `SELECT ruta_comprobante, serie_numero FROM tesoreria_movimiento
        WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!row) throw new NotFoundException('El movimiento no existe o fue dado de baja.');
    if (!row.ruta_comprobante) throw new NotFoundException('Este movimiento no tiene comprobante adjunto.');

    this.archivoService.enviar(row.ruta_comprobante, row.serie_numero || `movimiento-${id}`, res);
  }

  // ── CATÁLOGOS DE LOS ng-select ──────────────────────────────────────────────

  async buscarEmpresas(search = '', exactId?: number) {
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

  /** Cuentas de una empresa, con su saldo: es lo que el usuario mira antes de elegir. */
  async buscarCuentas(search = '', idEmpresa?: number, exactId?: number) {
    const where = [`cu.estado_registro = 'ACTIVO'`, `(cu.alias LIKE ? OR cu.numero_cuenta LIKE ?)`];
    const params: any[] = [`%${search}%`, `%${search}%`];
    if (idEmpresa) { where.push('cu.id_empresa = ?'); params.push(idEmpresa); }

    let orderBy = 'ORDER BY cu.alias ASC';
    if (exactId) {
      orderBy = 'ORDER BY CASE WHEN cu.id_cuenta = ? THEN 0 ELSE 1 END, cu.alias ASC';
      params.push(exactId);
    }

    const data = await this.dataSource.query(
      `SELECT cu.id_cuenta AS id, cu.alias AS nombre, cu.numero_cuenta, cu.moneda, cu.tipo,
              cu.saldo_actual, cu.id_empresa, b.nombre AS nombre_banco
         FROM tesoreria_cuenta cu
         LEFT JOIN planilla_banco b ON b.id_banco = cu.id_banco AND b.estado_registro = 'ACTIVO'
        WHERE ${where.join(' AND ')} ${orderBy} LIMIT 30`,
      params,
    );
    return { data: data.map((c: any) => ({ ...c, saldo_actual: num(c.saldo_actual) })) };
  }

  async buscarTerceros(search = '', idEmpresa?: number, exactId?: number) {
    const where = [`t.estado_registro = 'ACTIVO'`, `(t.razon_social LIKE ? OR t.numero_documento LIKE ?)`];
    const params: any[] = [`%${search}%`, `%${search}%`];
    if (idEmpresa) { where.push('t.id_empresa = ?'); params.push(idEmpresa); }

    let orderBy = 'ORDER BY t.razon_social ASC';
    if (exactId) {
      orderBy = 'ORDER BY CASE WHEN t.id_tercero = ? THEN 0 ELSE 1 END, t.razon_social ASC';
      params.push(exactId);
    }
    const data = await this.dataSource.query(
      `SELECT t.id_tercero AS id, t.razon_social AS nombre, t.numero_documento, t.es_cliente, t.es_proveedor
         FROM tesoreria_tercero t WHERE ${where.join(' AND ')} ${orderBy} LIMIT 30`,
      params,
    );
    return { data };
  }

  async buscarConceptos(search = '', idEmpresa?: number, exactId?: number) {
    const where = [
      `cc.estado_registro = 'ACTIVO'`, `s.estado_registro = 'ACTIVO'`, `ca.estado_registro = 'ACTIVO'`,
      '(cc.nombre LIKE ? OR s.nombre LIKE ? OR ca.nombre LIKE ?)',
    ];
    const params: any[] = [`%${search}%`, `%${search}%`, `%${search}%`];
    if (idEmpresa) { where.push('ca.id_empresa = ?'); params.push(idEmpresa); }

    let orderBy = 'ORDER BY ca.nombre ASC, s.nombre ASC, cc.nombre ASC';
    if (exactId) {
      orderBy = `ORDER BY CASE WHEN cc.id_centro_costo_concepto = ? THEN 0 ELSE 1 END, ca.nombre ASC`;
      params.push(exactId);
    }

    const data = await this.dataSource.query(
      `SELECT cc.id_centro_costo_concepto AS id, cc.nombre,
              CONCAT_WS(' › ', ca.nombre, s.nombre, cc.nombre) AS ruta
         FROM centro_costo_concepto cc
         INNER JOIN centro_costo_subcategoria s ON s.id_centro_costo_subcategoria = cc.id_centro_costo_subcategoria
         INNER JOIN centro_costo_categoria ca ON ca.id_centro_costo_categoria = s.id_centro_costo_categoria
        WHERE ${where.join(' AND ')} ${orderBy} LIMIT 30`,
      params,
    );
    return { data };
  }

  /** Catálogos cerrados y chicos: se mandan enteros, sin búsqueda ni paginación. */
  async getCatalogos() {
    const [mediosPago, bancos] = await Promise.all([
      this.dataSource.query(
        `SELECT id_medio_pago AS id, nombre, codigo, requiere_cuenta FROM tesoreria_medio_pago
          WHERE estado_registro = 'ACTIVO' ORDER BY orden ASC, nombre ASC`,
      ),
      // `planilla_banco` y no la Tabla 36 cruda de SUNAT: es la misma lista pero ya
      // depurada a los bancos que el estudio usa, y es la que referencia
      // `tesoreria_cuenta.id_banco`. Sacarla del catálogo crudo obligaría a mapear
      // código SUNAT ↔ id en cada consulta.
      this.dataSource.query(
        `SELECT id_banco AS id, nombre, codigo_sunat FROM planilla_banco
          WHERE estado_registro = 'ACTIVO' ORDER BY nombre ASC`,
      ),
    ]);
    return { mediosPago, bancos };
  }

  // ── EXPORTACIÓN ─────────────────────────────────────────────────────────────

  private columnasExport() {
    return [
      { header: 'ID', key: 'id_movimiento', width: 8 },
      { header: 'FECHA', key: 'fecha', width: 12 },
      { header: 'EMPRESA', key: 'nombre_empresa', width: 34 },
      { header: 'CUENTA', key: 'alias_cuenta', width: 24 },
      { header: 'BANCO', key: 'nombre_banco', width: 22 },
      { header: 'TIPO', key: 'tipo', width: 10 },
      { header: 'MONEDA', key: 'moneda', width: 9 },
      { header: 'MONTO', key: 'monto', width: 14 },
      { header: 'TERCERO', key: 'nombre_tercero', width: 30 },
      { header: 'MEDIO DE PAGO', key: 'nombre_medio_pago', width: 18 },
      { header: 'CENTRO DE COSTO', key: 'ruta_concepto', width: 38 },
      { header: 'DESCRIPCIÓN', key: 'descripcion', width: 40 },
      { header: 'ESTADO', key: 'estado_flujo', width: 14 },
    ];
  }

  async exportarExcel(query: any, res: Response) {
    const data = (await this.findAll(query, true)) as any[];
    await this.excelService.generarExcel(
      this.columnasExport(), data,
      `Movimientos_${new Date().toISOString().split('T')[0]}`, 'Movimientos', res,
    );
  }

  async exportarPdf(query: any, res: Response) {
    const data = (await this.findAll(query, true)) as any[];
    const columnas = this.columnasExport();

    const fmt = (valor: any, key: string) => {
      if (valor === null || valor === undefined || valor === '') return '—';
      if (key === 'monto') return num(valor).toFixed(2);
      if (key === 'fecha') return new Date(valor).toLocaleDateString('es-PE');
      return String(valor);
    };

    const filas = data
      .map((item) => `<tr class="${item.tipo === 'EGRESO' ? 'egreso' : 'ingreso'}">
        ${columnas.map((c) => `<td>${fmt(item[c.key], c.key)}</td>`).join('')}</tr>`)
      .join('');

    // Los totales se calculan sobre las filas que de verdad se imprimen, con los
    // mismos filtros que el usuario ve en pantalla. Separados por moneda: soles y
    // dólares nunca se suman entre sí.
    const acumular = (moneda: string, tipo: string) =>
      data.filter((i) => i.moneda === moneda && i.tipo === tipo).reduce((a, i) => a + num(i.monto), 0);

    const resumen = ['PEN', 'USD']
      .map((mo) => ({ mo, ing: acumular(mo, 'INGRESO'), egr: acumular(mo, 'EGRESO') }))
      .filter((r) => r.ing > 0 || r.egr > 0)
      .map((r) => `${r.mo === 'USD' ? 'US$' : 'S/'} &nbsp; Ingresos ${r.ing.toFixed(2)} &nbsp;·&nbsp; Egresos ${r.egr.toFixed(2)} &nbsp;·&nbsp; Neto ${(r.ing - r.egr).toFixed(2)}`)
      .join('<br>') || 'Sin movimientos';

    const html = `
    <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <style>
        @page { margin: 20px; size: A4 landscape; }
        body { font-size: 8px; color: #1e293b; margin: 0; }
        .header { border-bottom: 3px solid #0f243e; padding-bottom: 10px; margin-bottom: 14px; }
        .header h2 { margin: 0; color: #0f243e; font-size: 17px; text-transform: uppercase; }
        .header h1 { margin: 5px 0 0; font-size: 12px; text-transform: uppercase; color: #0f243e; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #0f243e; color: #fff; padding: 6px 5px; text-align: center; font-size: 8px; text-transform: uppercase; }
        td { padding: 5px; border-bottom: 1px solid #e2e8f0; text-align: center; }
        .totales { margin-top: 12px; font-size: 10px; font-weight: bold; text-align: right; color: #0f243e; line-height: 1.6; }
        .footer { margin-top: 12px; font-size: 7px; color: #94a3b8; text-align: center; }
    </style></head><body>
    <div class="header">
        <h2>Estudio Contable Barba</h2>
        <h1>Movimientos de tesorería</h1>
        <p style="margin:4px 0 0">Generado el: ${new Date().toLocaleString('es-PE')} · ${data.length} movimientos</p>
    </div>
    <table>
        <thead><tr>${columnas.map((c) => `<th>${c.header}</th>`).join('')}</tr></thead>
        <tbody>${filas || `<tr><td colspan="${columnas.length}" style="padding:26px;color:#94a3b8">Sin movimientos para los filtros aplicados</td></tr>`}</tbody>
    </table>
    <div class="totales">${resumen}</div>
    <div class="footer">
        Incluye solo los movimientos que pasan los filtros de la pantalla &nbsp;·&nbsp;
        Los anulados no suman a los totales &nbsp;·&nbsp;
        Soles y dólares nunca se suman entre sí
    </div>
    </body></html>`;

    await this.pdfHtmlService.generarPdf(
      html, `Movimientos_${new Date().toISOString().split('T')[0]}`, res, { landscape: true },
    );
  }
}

/**
 * La condición "cuenta para el saldo" con alias de tabla. Vive acá y no en
 * `cuentas-saldos.ts` porque solo la necesitan las queries del listado, que unen varias
 * tablas con columnas `estado` homónimas.
 */
function cuentaParaSaldoAlias(alias: string) {
  return `${alias}.estado = 'REGISTRADO' AND ${alias}.estado_registro = 'ACTIVO'`;
}

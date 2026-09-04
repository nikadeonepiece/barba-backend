import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { AuditoriaService, ExcelService, PdfService, pdfLayoutBordeado } from '@app/common';
import { CajasArchivoService } from './cajas-archivo.service';
import {
  CreateCajaDto, UpdateCajaDto, CreateMovimientoCajaDto, UpdateMovimientoCajaDto, AnularMovimientoCajaDto,
  RevisarMovimientoCajaDto,
} from './dto/caja.dto';

const COLS_ORDER_ALLOWED = ['fecha_apertura', 'nombre', 'saldo_actual', 'razon_social'];

/**
 * El movimiento que representa el fondo con el que se abrió la caja.
 *
 * No se edita ni se anula desde la pantalla de movimientos: es el reflejo de
 * `caja_chica.monto_inicial`, y tocarlo por un lado sin el otro descuadra el saldo.
 * Se corrige editando la cabecera de la caja (`update`), que actualiza los dos.
 */
const ORIGEN_APERTURA = 'caja_chica_apertura';

/**
 * Un movimiento solo es PLATA cuando está registrado Y aprobado.
 *
 * `estado` y `revision` responden dos preguntas distintas y por eso son dos columnas:
 * `estado` dice si el movimiento sigue vivo (un ANULADO no cuenta), `revision` dice si
 * el estudio ya lo validó (un gasto que cargó el cliente desde el portal nace
 * POR_REVISAR y no descuenta hasta que alguien lo mire). Esta condición es la única
 * definición de "cuenta para el saldo" en todo el módulo — si aparece escrita a mano en
 * otra query, es un lugar más donde el saldo puede empezar a diferir.
 */
const CUENTA_PARA_SALDO = `estado = 'REGISTRADO' AND revision = 'APROBADO' AND estado_registro = 'ACTIVO'`;

/**
 * Totales por caja, calculados desde el libro. No hace falta ninguna derivación
 * algebraica: como la apertura TAMBIÉN es un movimiento (tipo INGRESO), se cumple
 * `saldo_actual = total_ingresos - total_egresos` y las tres cifras que ve el usuario
 * salen de la misma fuente.
 *
 * `total_por_revisar` va aparte y NO entra en el saldo: es lo que el cliente ya cargó y
 * el estudio todavía no aprobó. Se muestra como aviso ("tenés 3 gastos esperando"),
 * porque si no fuera visible nadie los aprobaría nunca.
 */
const SUBQUERY_TOTALES = `
  SELECT id_caja,
         SUM(CASE WHEN ${CUENTA_PARA_SALDO} AND tipo = 'INGRESO' THEN monto ELSE 0 END) AS total_ingresos,
         SUM(CASE WHEN ${CUENTA_PARA_SALDO} AND tipo = 'EGRESO'  THEN monto ELSE 0 END) AS total_egresos,
         SUM(CASE WHEN estado = 'REGISTRADO' AND revision = 'POR_REVISAR' THEN monto ELSE 0 END) AS total_por_revisar,
         SUM(CASE WHEN estado = 'REGISTRADO' AND revision = 'POR_REVISAR' THEN 1 ELSE 0 END) AS movimientos_por_revisar,
         SUM(CASE WHEN estado = 'REGISTRADO' THEN 1 ELSE 0 END) AS total_movimientos
  FROM caja_chica_movimiento
  WHERE estado_registro = 'ACTIVO'
  GROUP BY id_caja`;

const num = (v: any) => Number(v ?? 0);
const soles = (v: any) => `S/ ${num(v).toFixed(2)}`;
const fechaPe = (v: any) => (v ? new Date(v).toLocaleDateString('es-PE') : '—');

/**
 * El driver de MySQL devuelve `DECIMAL` y `COUNT` como STRING, no como número.
 *
 * Si se retornan tal cual, el frontend recibe `"580.00"`: `saldo <= 0` compara texto,
 * un `+` concatena en vez de sumar y cualquier total calculado en pantalla sale mal
 * sin ningún error visible. Se convierten acá, en el borde del service, para que
 * ningún consumidor tenga que acordarse.
 */
const CAMPOS_NUMERICOS = [
  'monto_inicial', 'saldo_actual', 'total_ingresos', 'total_egresos', 'total_movimientos',
  'total_por_revisar', 'movimientos_por_revisar',
  'monto', 'saldo_anterior', 'saldo_posterior',
];

const aNumeros = <T extends Record<string, any>>(fila: T): T => {
  for (const campo of CAMPOS_NUMERICOS) {
    // `null` se conserva: en `saldo_anterior` significa "no se registró", y
    // convertirlo a 0 diría que el saldo era cero, que es otra cosa.
    if (fila?.[campo] !== undefined && fila[campo] !== null) (fila as any)[campo] = Number(fila[campo]);
  }
  return fila;
};

@Injectable()
export class CajasService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private archivoService: CajasArchivoService,
    private excelService: ExcelService,
    private pdfService: PdfService,
  ) {}

  // ==========================================================
  // CATÁLOGOS DE LOS DESPLEGABLES
  // ==========================================================

  /**
   * Empresas para el filtro y para el alta. Van precargadas completas: son 171 y es
   * lo que ya hacen `planilla/trabajadores` y `planilla/contratos` con el mismo
   * dropdown. Paginarlo solo acá dejaría dos comportamientos distintos para el mismo
   * combo en pantallas vecinas.
   */
  findEmpresas() {
    return this.dataSource.query(
      `SELECT e.id_empresa, e.razon_social, e.ruc
       FROM empresa e
       WHERE e.estado_registro = 'ACTIVO' AND e.estado_cliente = 'ACTIVO'
       ORDER BY e.razon_social`,
    );
  }

  /** Catálogo cerrado y chico (13 filas): se precarga entero, sin buscador en backend. */
  findConceptos() {
    return this.dataSource.query(
      `SELECT c.id_caja_concepto, c.codigo, c.nombre, c.tipo
       FROM caja_chica_concepto c
       WHERE c.estado_registro = 'ACTIVO'
       ORDER BY c.orden, c.nombre`,
    );
  }

  // ==========================================================
  // LISTADO DE CAJAS
  // ==========================================================

  /**
   * `isExport` sube el límite y devuelve el array pelado: el Excel y el PDF tienen que
   * traer TODO lo que el filtro selecciona, no la página que se está viendo.
   */
  async findAll(query: any, isExport = false) {
    const page = isExport ? 1 : Number(query.page) || 1;
    const limit = isExport ? 5000 : Number(query.limit) || 10;
    const offset = (page - 1) * limit;

    const { whereSql, params } = this.filtroCajas(query);
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort) ? query.sort : 'fecha_apertura';
    const sortDir = query.dir === 'ASC' ? 'ASC' : 'DESC';
    // `razon_social` es de la tabla unida, no de la caja: hay que prefijarla distinto.
    const sortSql = sortCol === 'razon_social' ? `e.razon_social ${sortDir}` : `cc.${sortCol} ${sortDir}`;

    const sqlData = `
      SELECT cc.id_caja, cc.id_empresa, cc.nombre, cc.responsable,
             cc.monto_inicial, cc.saldo_actual, cc.estado,
             cc.fecha_apertura, cc.fecha_cierre, cc.observaciones,
             e.razon_social, e.ruc,
             COALESCE(m.total_ingresos, 0)    AS total_ingresos,
             COALESCE(m.total_egresos, 0)     AS total_egresos,
             COALESCE(m.total_movimientos, 0) AS total_movimientos,
             COALESCE(m.total_por_revisar, 0) AS total_por_revisar,
             COALESCE(m.movimientos_por_revisar, 0) AS movimientos_por_revisar
      FROM caja_chica cc
      INNER JOIN empresa e ON e.id_empresa = cc.id_empresa
      LEFT JOIN (${SUBQUERY_TOTALES}) m ON m.id_caja = cc.id_caja
      ${whereSql}
      ORDER BY ${sortSql}, cc.id_caja DESC
      LIMIT ? OFFSET ?`;

    if (isExport) return this.dataSource.query(sqlData, [...params, limit, offset]);

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(sqlData, [...params, limit, offset]),
      this.dataSource.query(
        `SELECT COUNT(*) AS total
         FROM caja_chica cc
         INNER JOIN empresa e ON e.id_empresa = cc.id_empresa
         ${whereSql}`,
        params,
      ),
    ]);

    return { data: data.map(aNumeros), meta: { total: Number(total), page, limit } };
  }

  /**
   * Tarjetas de la cabecera. Usan EXACTAMENTE el mismo filtro que el listado: si
   * calcularan sobre otro conjunto, el usuario vería un total que no es la suma de lo
   * que tiene delante y no habría forma de explicarle la diferencia.
   */
  async resumen(query: any) {
    const { whereSql, params } = this.filtroCajas(query);

    const [row] = await this.dataSource.query(
      `SELECT COUNT(*) AS total_cajas,
              SUM(CASE WHEN cc.estado = 'ABIERTA' THEN 1 ELSE 0 END) AS cajas_abiertas,
              COALESCE(SUM(cc.saldo_actual), 0)        AS total_saldo,
              COALESCE(SUM(m.total_ingresos), 0)       AS total_ingresos,
              COALESCE(SUM(m.total_egresos), 0)        AS total_egresos,
              COALESCE(SUM(m.total_por_revisar), 0)    AS total_por_revisar,
              COALESCE(SUM(m.movimientos_por_revisar), 0) AS movimientos_por_revisar
       FROM caja_chica cc
       INNER JOIN empresa e ON e.id_empresa = cc.id_empresa
       LEFT JOIN (${SUBQUERY_TOTALES}) m ON m.id_caja = cc.id_caja
       ${whereSql}`,
      params,
    );

    return {
      total_cajas: num(row?.total_cajas),
      cajas_abiertas: num(row?.cajas_abiertas),
      total_ingresos: num(row?.total_ingresos),
      total_egresos: num(row?.total_egresos),
      total_saldo: num(row?.total_saldo),
      // Lo que el cliente cargó y todavía nadie aprobó. No está en el saldo: es un
      // aviso de trabajo pendiente, no plata.
      total_por_revisar: num(row?.total_por_revisar),
      movimientos_por_revisar: num(row?.movimientos_por_revisar),
    };
  }

  /** Filtro compartido por listado, resumen y exportaciones — un solo lugar que decide qué entra. */
  private filtroCajas(query: any): { whereSql: string; params: any[] } {
    const where: string[] = ["cc.estado_registro = 'ACTIVO'"];
    const params: any[] = [];

    const idEmpresa = Number(query?.id_empresa);
    if (idEmpresa > 0) {
      where.push('cc.id_empresa = ?');
      params.push(idEmpresa);
    }
    if (query?.estado === 'ABIERTA' || query?.estado === 'CERRADA') {
      where.push('cc.estado = ?');
      params.push(query.estado);
    }
    if (query?.search) {
      where.push('(cc.nombre LIKE ? OR cc.responsable LIKE ? OR e.razon_social LIKE ? OR e.ruc LIKE ?)');
      const termino = `%${String(query.search).trim()}%`;
      params.push(termino, termino, termino, termino);
    }

    return { whereSql: `WHERE ${where.join(' AND ')}`, params };
  }

  /**
   * Cabecera de UNA caja, con las mismas cifras derivadas que su fila del listado.
   *
   * La usa la sub-vista `tesoreria/cajas/ver/:id`, que se abre directo por URL (F5,
   * link compartido) sin haber pasado antes por el listado.
   */
  async findOne(id: number) {
    const [caja] = await this.dataSource.query(
      `SELECT cc.id_caja, cc.id_empresa, cc.nombre, cc.responsable,
              cc.monto_inicial, cc.saldo_actual, cc.estado,
              cc.fecha_apertura, cc.fecha_cierre, cc.observaciones,
              e.razon_social, e.ruc,
              COALESCE(m.total_ingresos, 0)    AS total_ingresos,
              COALESCE(m.total_egresos, 0)     AS total_egresos,
              COALESCE(m.total_movimientos, 0) AS total_movimientos,
              COALESCE(m.total_por_revisar, 0) AS total_por_revisar,
              COALESCE(m.movimientos_por_revisar, 0) AS movimientos_por_revisar
       FROM caja_chica cc
       INNER JOIN empresa e ON e.id_empresa = cc.id_empresa
       LEFT JOIN (${SUBQUERY_TOTALES}) m ON m.id_caja = cc.id_caja
       WHERE cc.id_caja = ? AND cc.estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!caja) throw new NotFoundException('Caja no encontrada');
    return aNumeros(caja);
  }

  // ==========================================================
  // ABRIR / CORREGIR / CERRAR / DAR DE BAJA
  // ==========================================================

  /**
   * Abre la caja y deja registrado el fondo inicial como primer movimiento.
   *
   * Los dos INSERT van en la misma transacción: una caja con `monto_inicial = 500` y
   * sin su movimiento de apertura muestra un saldo de 500 que el estado de cuenta no
   * puede explicar.
   */
  async create(dto: CreateCajaDto, userId: number) {
    const [empresa] = await this.dataSource.query(
      `SELECT id_empresa, razon_social FROM empresa
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO' AND estado_cliente = 'ACTIVO'`,
      [dto.id_empresa],
    );
    if (!empresa) throw new BadRequestException('La empresa no existe o no está activa como cliente');

    const nombre = dto.nombre.trim();
    const responsable = dto.responsable?.trim() || null;
    const observaciones = dto.observaciones?.trim() || null;
    const montoInicial = num(dto.monto_inicial);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const res: any = await qr.query(
        `INSERT INTO caja_chica
          (id_empresa, nombre, responsable, monto_inicial, saldo_actual, estado,
           fecha_apertura, observaciones, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, 'ABIERTA', ?, ?, 'ACTIVO', ?)`,
        [dto.id_empresa, nombre, responsable, montoInicial, montoInicial, dto.fecha_apertura, observaciones, userId],
      );
      const idCaja = Number(res.insertId);

      await qr.query(
        `INSERT INTO caja_chica_movimiento
          (id_caja, tipo, fecha, monto, medio_pago, saldo_anterior, saldo_posterior,
           descripcion, tipo_comprobante, tabla_origen, estado, estado_registro, id_usuario_crea)
         VALUES (?, 'INGRESO', ?, ?, 'EFECTIVO', 0, ?, ?, 'NINGUNO', ?, 'REGISTRADO', 'ACTIVO', ?)`,
        [idCaja, dto.fecha_apertura, montoInicial, montoInicial, 'Apertura de caja — fondo inicial', ORIGEN_APERTURA, userId],
      );

      await this.auditoriaService.registrarConTransaccion(qr, 'caja_chica', idCaja, 'CREAR', userId, null, {
        ...dto, nombre, responsable, observaciones,
      });

      await qr.commitTransaction();
      return { id: idCaja, mensaje: 'Caja abierta correctamente' };
    } catch (error: any) {
      await qr.rollbackTransaction();
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException(
          `"${empresa.razon_social}" ya tiene una caja llamada "${nombre}". Ponle otro nombre (por ejemplo el local o el área) para poder distinguirlas.`,
        );
      }
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * Corrige la cabecera de una caja abierta, fondo inicial incluido.
   *
   * Cambiar el fondo toca el movimiento de apertura y, con él, toda la cadena de
   * saldos: por eso se sincronizan los tres (cabecera, movimiento de apertura y saldos
   * corridos) dentro de la misma transacción. Se rechaza si el resultado deja la caja
   * en negativo.
   *
   * La empresa no se puede cambiar acá (no está en el DTO): sería otra caja, y los
   * movimientos ya registrados quedarían atribuidos a un cliente que no es.
   */
  async update(id: number, dto: UpdateCajaDto, userId: number) {
    const nombre = dto.nombre.trim();
    const responsable = dto.responsable?.trim() || null;
    const observaciones = dto.observaciones?.trim() || null;
    const montoNuevo = num(dto.monto_inicial);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const caja = await this.bloquearCaja(qr, id, false);
      if (caja.estado === 'CERRADA') {
        throw new BadRequestException(
          'Esta caja está cerrada y ya no se puede corregir. Si el fondo estaba mal, abre una caja nueva con el monto correcto.',
        );
      }

      const res: any = await qr.query(
        `UPDATE caja_chica
         SET nombre = ?, responsable = ?, monto_inicial = ?,
             fecha_apertura = ?, observaciones = ?, id_usuario_mod = ?
         WHERE id_caja = ? AND estado_registro = 'ACTIVO'`,
        [nombre, responsable, montoNuevo, dto.fecha_apertura, observaciones, userId, id],
      );
      if (res.affectedRows === 0) throw new NotFoundException('Caja no encontrada');

      // El movimiento de apertura tiene que reflejar el mismo monto y la misma fecha:
      // es la primera línea del estado de cuenta y sin esto seguiría diciendo el monto
      // viejo. No se exige que el UPDATE afecte filas: una caja migrada a mano podría
      // no tenerlo, y eso no es motivo para abortar.
      await qr.query(
        `UPDATE caja_chica_movimiento
         SET monto = ?, fecha = ?, id_usuario_mod = ?
         WHERE id_caja = ? AND tabla_origen = ? AND estado_registro = 'ACTIVO'`,
        [montoNuevo, dto.fecha_apertura, userId, id, ORIGEN_APERTURA],
      );

      // Corregir el fondo mueve TODA la historia de saldos de la caja, no solo el
      // total: sin rearmar la cadena, la columna SALDO del estado de cuenta se queda
      // con los valores del monto viejo y la última fila deja de coincidir con el
      // saldo real de la caja.
      const { saldo: saldoFinal, minimo, fechaMinimo } = await this.recalcularSaldos(qr, id, userId);

      if (minimo < 0) {
        throw new BadRequestException(
          `Con un fondo inicial de ${soles(montoNuevo)} la caja quedaría en ${soles(minimo)} al ${fechaPe(fechaMinimo)}: ` +
            'para esa fecha ya se había gastado más de ese fondo. Sube el fondo o anula primero los movimientos que estén mal.',
        );
      }

      await this.auditoriaService.registrarConTransaccion(qr, 'caja_chica', id, 'ACTUALIZAR', userId, caja, {
        ...dto, nombre, responsable, observaciones, saldo_actual: saldoFinal,
      });

      await qr.commitTransaction();
      return { id, saldo_actual: saldoFinal, mensaje: 'Caja actualizada correctamente' };
    } catch (error: any) {
      await qr.rollbackTransaction();
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException(`Esa empresa ya tiene otra caja llamada "${nombre}".`);
      }
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * Cierra la caja: deja de aceptar movimientos.
   *
   * No se exige saldo cero. Una caja se cierra con lo que le haya quedado y ese saldo
   * es justamente el dato de la rendición — obligar a "cuadrar en cero" solo empuja a
   * inventar un movimiento de ajuste.
   */
  async cerrar(id: number, userId: number) {
    const caja = await this.findOne(id);
    if (caja.estado === 'CERRADA') throw new BadRequestException('Esta caja ya está cerrada');

    const res: any = await this.dataSource.query(
      `UPDATE caja_chica SET estado = 'CERRADA', fecha_cierre = CURDATE(), id_usuario_mod = ?
       WHERE id_caja = ? AND estado = 'ABIERTA' AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Caja no encontrada');

    await this.auditoriaService.registrar('caja_chica', id, 'ACTUALIZAR', userId, caja, { estado: 'CERRADA' });
    return { id, mensaje: 'Caja cerrada correctamente' };
  }

  /**
   * Baja lógica — solo de una caja que nunca se usó.
   *
   * Una caja con gastos registrados no se elimina: esos movimientos son el respaldo de
   * plata que ya salió y el cliente los tiene rendidos. Lo que corresponde ahí es
   * CERRARLA, que la saca de circulación sin borrar el rastro.
   */
  async remove(id: number, userId: number) {
    const caja = await this.findOne(id);

    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM caja_chica_movimiento
       WHERE id_caja = ? AND estado_registro = 'ACTIVO' AND (tabla_origen IS NULL OR tabla_origen <> ?)`,
      [id, ORIGEN_APERTURA],
    );
    if (Number(total) > 0) {
      throw new ConflictException(
        `Esta caja ya tiene ${total} movimiento(s) registrado(s) y no se puede eliminar: son el respaldo de plata que ya se movió. Ciérrala en vez de eliminarla.`,
      );
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const res: any = await qr.query(
        `UPDATE caja_chica SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
         WHERE id_caja = ? AND estado_registro = 'ACTIVO'`,
        [userId, id],
      );
      if (res.affectedRows === 0) throw new NotFoundException('Caja no encontrada');

      // El movimiento de apertura se va con ella: sin la caja no significa nada, y
      // dejarlo activo haría que el libro tenga huérfanos.
      await qr.query(
        `UPDATE caja_chica_movimiento SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
         WHERE id_caja = ? AND estado_registro = 'ACTIVO'`,
        [userId, id],
      );

      await this.auditoriaService.registrarConTransaccion(qr, 'caja_chica', id, 'ELIMINAR', userId, caja, null);
      await qr.commitTransaction();
      return { id, mensaje: 'Caja eliminada correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  // ==========================================================
  // MOVIMIENTOS
  // ==========================================================

  /**
   * Rango de fechas del libro. Se arma una sola vez porque lo usan el listado
   * paginado de la pantalla y el estado de cuenta que se descarga: si cada uno
   * filtrara distinto, lo descargado no cuadraría con lo que el usuario está viendo.
   *
   * El límite superior va con `< fecha_fin + 1 día` y no con `<=`: si algún día la
   * columna pasa a DATETIME, un `<=` se comería el último día completo.
   */
  private filtroMovimientos(query: any = {}): { whereSql: string; params: any[] } {
    const where: string[] = ["m.estado_registro = 'ACTIVO'"];
    const params: any[] = [];

    if (query.fecha_inicio) {
      where.push('m.fecha >= ?');
      params.push(query.fecha_inicio);
    }
    if (query.fecha_fin) {
      where.push('m.fecha < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(query.fecha_fin);
    }
    if (query.tipo === 'INGRESO' || query.tipo === 'EGRESO') {
      where.push('m.tipo = ?');
      params.push(query.tipo);
    }
    // Los anulados se muestran por defecto (tachados) porque son parte del rastro;
    // se pueden esconder cuando lo que se quiere es leer solo la plata real.
    if (query.ocultarAnulados === 'true') {
      where.push("m.estado = 'REGISTRADO'");
    }
    // La bandeja de revisión del estudio: los gastos que cargó el cliente y siguen
    // esperando. Es el filtro que hace que el saldo "por revisar" sea accionable.
    if (query.revision === 'APROBADO' || query.revision === 'POR_REVISAR' || query.revision === 'RECHAZADO') {
      where.push('m.revision = ?');
      params.push(query.revision);
    }

    return { whereSql: where.join(' AND '), params };
  }

  async findMovimientos(idCaja: number, query: any = {}, isExport = false) {
    await this.findOne(idCaja); // 404 antes de listar: sin cabecera no hay libro que mostrar

    const page = isExport ? 1 : Number(query.page) || 1;
    const limit = isExport ? 5000 : Number(query.limit) || 20;
    const offset = (page - 1) * limit;
    const { whereSql, params } = this.filtroMovimientos(query);

    const sqlData = `
      SELECT m.id_movimiento, m.id_caja, m.tipo, m.fecha, m.monto, m.medio_pago,
             m.saldo_anterior, m.saldo_posterior, m.descripcion,
             m.tipo_comprobante, m.nro_comprobante, m.ruta_comprobante, m.nombre_comprobante,
             m.tabla_origen, m.estado, m.motivo_anulacion,
             m.revision, m.motivo_rechazo,
             m.id_caja_concepto, c.nombre AS nombre_concepto, c.codigo AS codigo_concepto,
             CONCAT_WS(' ', u.nombres, u.apellidos) AS usuario_registra,
             -- Quién lo cargó: un gasto que entró por el portal lo tipeó el cliente, no
             -- el estudio, y en la revisión eso es justo lo que hay que saber.
             CASE WHEN u.id_empresa IS NULL THEN 'ESTUDIO' ELSE 'CLIENTE' END AS origen_registro
      FROM caja_chica_movimiento m
      LEFT JOIN caja_chica_concepto c ON c.id_caja_concepto = m.id_caja_concepto AND c.estado_registro = 'ACTIVO'
      LEFT JOIN sis_usuario u ON u.id_usuario = m.id_usuario_crea
      WHERE m.id_caja = ? AND ${whereSql}
      ORDER BY m.fecha DESC, m.id_movimiento DESC
      LIMIT ? OFFSET ?`;

    if (isExport) return this.dataSource.query(sqlData, [idCaja, ...params, limit, offset]);

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(sqlData, [idCaja, ...params, limit, offset]),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM caja_chica_movimiento m WHERE m.id_caja = ? AND ${whereSql}`,
        [idCaja, ...params],
      ),
    ]);

    return { data: data.map(aNumeros), meta: { total: Number(total), page, limit } };
  }

  /**
   * Registra un ingreso o un gasto y recalcula el saldo en la MISMA transacción.
   *
   * El orden es: bloquear → insertar → recalcular → validar. Validar DESPUÉS de
   * escribir parece al revés, pero es lo correcto acá: el movimiento puede entrar con
   * fecha retroactiva, así que el efecto sobre el saldo no se conoce hasta rearmar la
   * cadena completa. Si el resultado no sirve, el rollback deshace el INSERT y no
   * queda rastro.
   */
  async createMovimiento(dto: CreateMovimientoCajaDto, userId: number) {
    const idConcepto = await this.validarConcepto(dto.id_caja_concepto, dto.tipo);
    const monto = num(dto.monto);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const caja = await this.bloquearCaja(qr, dto.id_caja);
      const saldoPrevio = num(caja.saldo_actual);

      const res: any = await qr.query(
        `INSERT INTO caja_chica_movimiento
          (id_caja, id_caja_concepto, tipo, fecha, monto, medio_pago,
           descripcion, tipo_comprobante, nro_comprobante, ruta_comprobante, nombre_comprobante,
           estado, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTRADO', 'ACTIVO', ?)`,
        [
          dto.id_caja, idConcepto, dto.tipo, dto.fecha, monto, dto.medio_pago ?? 'EFECTIVO',
          dto.descripcion?.trim() || null,
          dto.tipo_comprobante ?? 'NINGUNO',
          dto.nro_comprobante?.trim() || null,
          dto.ruta_comprobante || null,
          dto.nombre_comprobante?.trim() || null,
          userId,
        ],
      );
      const idMovimiento = Number(res.insertId);

      // `saldo_anterior`/`saldo_posterior` no se calculan en el INSERT: los pone el
      // recálculo, que es el único que conoce la posición real de este movimiento
      // dentro de la cadena una vez ordenada por fecha.
      const { saldo: saldoFinal, minimo, fechaMinimo } = await this.recalcularSaldos(qr, dto.id_caja, userId);

      if (minimo < 0) {
        throw new BadRequestException(
          `El gasto de ${soles(monto)} deja la caja en ${soles(minimo)} al ${fechaPe(fechaMinimo)}: en esa fecha no había ese saldo. ` +
            `Hoy la caja tiene ${soles(saldoPrevio)}. Si el gasto es correcto, registra antes la reposición del fondo con su fecha real.`,
        );
      }

      await this.auditoriaService.registrarConTransaccion(qr, 'caja_chica_movimiento', idMovimiento, 'CREAR', userId, null, { ...dto, monto });

      await qr.commitTransaction();
      return { id: idMovimiento, saldo_actual: saldoFinal, mensaje: 'Movimiento registrado correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      // La subida es un paso aparte del guardado: si el INSERT falla, el archivo ya
      // está en disco y sin esto queda huérfano para siempre.
      this.archivoService.borrarSiExiste(dto.ruta_comprobante);
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * Corrige un movimiento ya registrado aplicando al saldo solo la DIFERENCIA.
   *
   * El tipo y la caja no se tocan (no están en el DTO). Un movimiento ANULADO tampoco
   * se edita: su efecto ya se revirtió y volver a tocarlo movería un saldo que él ya
   * no sostiene.
   */
  async updateMovimiento(id: number, dto: UpdateMovimientoCajaDto, userId: number) {
    const montoNuevo = num(dto.monto);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const [mov] = await qr.query(
        `SELECT * FROM caja_chica_movimiento WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
        [id],
      );
      if (!mov) throw new NotFoundException('Movimiento no encontrado');
      if (mov.tabla_origen === ORIGEN_APERTURA) {
        throw new BadRequestException(
          'Este es el fondo con el que se abrió la caja. Para corregirlo, edita la caja desde el listado: así se ajustan a la vez el monto inicial y el saldo.',
        );
      }
      if (mov.estado === 'ANULADO') {
        throw new BadRequestException('Este movimiento está anulado. Registra uno nuevo en lugar de editarlo.');
      }

      const caja = await this.bloquearCaja(qr, mov.id_caja);
      const saldoPrevio = num(caja.saldo_actual);

      const idConcepto = await this.validarConcepto(dto.id_caja_concepto, mov.tipo);

      // El comprobante nuevo reemplaza al anterior; si no se mandó ninguno, se
      // conserva el que ya estaba (editar el monto no debe borrar la boleta).
      const rutaNueva = dto.ruta_comprobante || mov.ruta_comprobante;
      const nombreNuevo = dto.ruta_comprobante ? dto.nombre_comprobante?.trim() || null : mov.nombre_comprobante;

      await qr.query(
        `UPDATE caja_chica_movimiento
         SET id_caja_concepto = ?, monto = ?, fecha = ?, medio_pago = ?, descripcion = ?,
             tipo_comprobante = ?, nro_comprobante = ?, ruta_comprobante = ?, nombre_comprobante = ?,
             id_usuario_mod = ?
         WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
        [
          idConcepto, montoNuevo, dto.fecha, dto.medio_pago ?? mov.medio_pago,
          dto.descripcion?.trim() || null,
          dto.tipo_comprobante ?? mov.tipo_comprobante,
          dto.nro_comprobante?.trim() || null,
          rutaNueva, nombreNuevo,
          userId, id,
        ],
      );

      // Cambiar la FECHA reordena la cadena, así que los saldos no se ajustan: se
      // rearman enteros. Es también lo que mantiene alineada la columna del estado de
      // cuenta cuando la corrección cae en medio de la historia.
      const { saldo: saldoFinal, minimo, fechaMinimo } = await this.recalcularSaldos(qr, mov.id_caja, userId);

      if (minimo < 0) {
        throw new BadRequestException(
          `Con ${soles(montoNuevo)} la caja quedaría en ${soles(minimo)} al ${fechaPe(fechaMinimo)}: en esa fecha no había ese saldo. ` +
            `Hoy la caja tiene ${soles(saldoPrevio)}.`,
        );
      }

      await this.auditoriaService.registrarConTransaccion(qr, 'caja_chica_movimiento', id, 'ACTUALIZAR', userId, mov, { ...dto, monto: montoNuevo });

      await qr.commitTransaction();

      // Recién con el commit hecho: si se hubiera borrado antes y la transacción
      // fallara, el movimiento seguiría apuntando a un archivo que ya no está.
      if (dto.ruta_comprobante && mov.ruta_comprobante && dto.ruta_comprobante !== mov.ruta_comprobante) {
        this.archivoService.borrarSiExiste(mov.ruta_comprobante);
      }

      return { id, saldo_actual: saldoFinal, mensaje: 'Movimiento actualizado correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      if (dto.ruta_comprobante) this.archivoService.borrarSiExiste(dto.ruta_comprobante);
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * Anula un movimiento y revierte su efecto sobre el saldo.
   *
   * No se borra la fila ni el archivo: el arqueo de ese día ya se firmó con el
   * movimiento adentro, y quien revise el libro tiene que poder ver que existió y por
   * qué se dio de baja.
   */
  async anularMovimiento(id: number, dto: AnularMovimientoCajaDto, userId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const [mov] = await qr.query(
        `SELECT * FROM caja_chica_movimiento WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
        [id],
      );
      if (!mov) throw new NotFoundException('Movimiento no encontrado');
      if (mov.tabla_origen === ORIGEN_APERTURA) {
        throw new BadRequestException(
          'El fondo de apertura no se anula: es la caja misma. Si la caja no debía existir, elimínala desde el listado.',
        );
      }
      if (mov.estado === 'ANULADO') throw new BadRequestException('Este movimiento ya está anulado');

      await this.bloquearCaja(qr, mov.id_caja);

      await qr.query(
        `UPDATE caja_chica_movimiento
         SET estado = 'ANULADO', motivo_anulacion = ?, id_usuario_anula = ?, id_usuario_mod = ?
         WHERE id_movimiento = ? AND estado = 'REGISTRADO' AND estado_registro = 'ACTIVO'`,
        [dto.motivo.trim(), userId, userId, id],
      );

      // Un ANULADO entra en la cadena con delta 0: la fila queda visible con su motivo,
      // pero deja de mover plata y todos los saldos posteriores se corren solos.
      const { saldo: saldoFinal, minimo, fechaMinimo } = await this.recalcularSaldos(qr, mov.id_caja, userId);

      if (minimo < 0) {
        throw new BadRequestException(
          `Anular este ingreso de ${soles(mov.monto)} deja la caja en ${soles(minimo)} al ${fechaPe(fechaMinimo)}: esa plata ya se gastó. ` +
            'Anula primero los gastos que salieron de ella.',
        );
      }

      await this.auditoriaService.registrarConTransaccion(qr, 'caja_chica_movimiento', id, 'ANULAR', userId, mov, null);

      await qr.commitTransaction();
      return { id, saldo_actual: saldoFinal, mensaje: 'Movimiento anulado correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * Aprueba o rechaza un gasto que cargó el cliente desde el portal.
   *
   * Es el control que justifica que el portal pueda escribir montos: hasta que alguien
   * del estudio pasa por acá, el gasto se ve pero no descuenta. Aprobar lo mete en la
   * cadena de saldos; rechazar lo deja visible para el cliente con el motivo, que es lo
   * que le dice qué corregir — por eso el motivo es obligatorio al rechazar.
   *
   * Solo se revisa lo que está POR_REVISAR: volver a tocar algo ya aprobado movería el
   * saldo dos veces, y lo ya rechazado el cliente tiene que volver a cargarlo.
   */
  async revisarMovimiento(id: number, dto: RevisarMovimientoCajaDto, userId: number) {
    const aprobar = dto.decision === 'APROBADO';

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const [mov] = await qr.query(
        `SELECT * FROM caja_chica_movimiento WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
        [id],
      );
      if (!mov) throw new NotFoundException('Movimiento no encontrado');
      if (mov.revision !== 'POR_REVISAR') {
        throw new BadRequestException(
          mov.revision === 'APROBADO'
            ? 'Este movimiento ya está aprobado. Si estaba mal, anúlalo en vez de volver a revisarlo.'
            : 'Este movimiento ya fue rechazado. El cliente tiene que cargarlo de nuevo con la corrección.',
        );
      }

      await this.bloquearCaja(qr, mov.id_caja);

      await qr.query(
        `UPDATE caja_chica_movimiento
         SET revision = ?, motivo_rechazo = ?, id_usuario_revisa = ?, id_usuario_mod = ?
         WHERE id_movimiento = ? AND revision = 'POR_REVISAR' AND estado_registro = 'ACTIVO'`,
        [dto.decision, aprobar ? null : dto.motivo!.trim(), userId, userId, id],
      );

      const { saldo: saldoFinal, minimo, fechaMinimo } = await this.recalcularSaldos(qr, mov.id_caja, userId);

      // Solo al APROBAR puede quedar en rojo: rechazar nunca resta plata. El gasto se
      // rechaza en los hechos, y el mensaje explica por qué no se pudo aprobar.
      if (minimo < 0) {
        throw new BadRequestException(
          `Aprobar este gasto de ${soles(mov.monto)} deja la caja en ${soles(minimo)} al ${fechaPe(fechaMinimo)}: ` +
            'en esa fecha no había ese saldo. Registra la reposición del fondo con su fecha real y volvé a aprobarlo.',
        );
      }

      await this.auditoriaService.registrarConTransaccion(
        qr, 'caja_chica_movimiento', id, 'ACTUALIZAR', userId, mov, { revision: dto.decision, motivo: dto.motivo ?? null },
      );

      await qr.commitTransaction();
      return {
        id,
        saldo_actual: saldoFinal,
        mensaje: aprobar ? 'Gasto aprobado: ya descuenta del saldo' : 'Gasto rechazado',
      };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * Bloquea la caja para el resto de la transacción y valida que acepte cambios.
   *
   * El `FOR UPDATE` es lo que impide que dos gastos simultáneos lean el mismo saldo,
   * los dos pasen la validación y la caja termine en negativo. El `disabled` del botón
   * en el frontend no protege de esto (dos pestañas, dos usuarios, un reintento de red).
   *
   * Recibe el `QueryRunner` en vez de abrir uno propio: abrir una transacción dentro de
   * otra deja la de afuera sin efecto sobre estas queries.
   */
  private async bloquearCaja(qr: QueryRunner, idCaja: number, exigirAbierta = true): Promise<any> {
    const [caja] = await qr.query(
      `SELECT * FROM caja_chica WHERE id_caja = ? AND estado_registro = 'ACTIVO' FOR UPDATE`,
      [idCaja],
    );
    if (!caja) throw new NotFoundException('Caja no encontrada');
    if (exigirAbierta && caja.estado === 'CERRADA') {
      throw new BadRequestException(
        'Esta caja está cerrada y ya no acepta cambios. Abre una caja nueva para el periodo siguiente.',
      );
    }
    return caja;
  }

  /**
   * Recalcula el saldo corrido de TODA la caja y lo baja a `caja_chica.saldo_actual`.
   * Devuelve el saldo final y el punto MÁS BAJO de la cadena, con su fecha.
   *
   * Por qué recalcular en vez de sumar la diferencia, que es lo que hacía antes:
   *
   *   · Un movimiento se registra con la fecha que el usuario elige, y esa fecha puede
   *     ser ANTERIOR a movimientos ya cargados (la boleta apareció una semana después).
   *     Con ajustes incrementales, el `saldo_posterior` de las filas siguientes se
   *     quedaba con el valor viejo y la columna SALDO del estado de cuenta dejaba de
   *     cuadrar con el saldo real de la caja.
   *   · Corregir el fondo de apertura tenía el mismo efecto sobre TODA la historia.
   *
   * Con esto, la columna que ve el contador es un saldo corrido de verdad y el saldo de
   * la caja sale siempre de la misma fuente que el libro: no hay dos caminos para
   * llegar al mismo número, que es como aparecen los descuadres.
   *
   * El costo es aceptable: una caja chica se mide en decenas de movimientos por mes, y
   * la ventana la resuelve MySQL en una sola sentencia (nada de N updates en un loop).
   * Los ANULADOS entran en la cadena con delta 0: siguen visibles, pero no mueven plata.
   *
   * Devuelve también el MÍNIMO porque validar solo el saldo final no alcanza: un fondo
   * mal corregido, o un gasto cargado con fecha vieja, puede terminar en positivo y aun
   * así dejar la caja en rojo en el medio — y una caja no pudo gastar plata que en ese
   * momento no tenía. Quien llame valida `minimo` y deja que el rollback deshaga todo.
   */
  private async recalcularSaldos(
    qr: QueryRunner, idCaja: number, userId: number,
  ): Promise<{ saldo: number; minimo: number; fechaMinimo: string | null }> {
    await qr.query(
      `UPDATE caja_chica_movimiento m
       INNER JOIN (
         SELECT id_movimiento, delta,
                SUM(delta) OVER (ORDER BY fecha, id_movimiento ROWS UNBOUNDED PRECEDING) AS posterior
         FROM (
           SELECT id_movimiento, fecha,
                  CASE WHEN ${CUENTA_PARA_SALDO}
                       THEN CASE WHEN tipo = 'INGRESO' THEN monto ELSE -monto END
                       ELSE 0 END AS delta
           FROM caja_chica_movimiento
           WHERE id_caja = ? AND estado_registro = 'ACTIVO'
         ) base
       ) x ON x.id_movimiento = m.id_movimiento
       SET m.saldo_anterior = x.posterior - x.delta,
           m.saldo_posterior = x.posterior`,
      [idCaja],
    );

    // El saldo de la caja es el último eslabón de esa cadena. `COALESCE` cubre la caja
    // que se quedó sin ningún movimiento activo (no debería pasar, pero un 0 explícito
    // es mejor que un NULL que después se lee como "sin datos").
    const [fila] = await qr.query(
      `SELECT COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO}
                                THEN CASE WHEN tipo = 'INGRESO' THEN monto ELSE -monto END
                                ELSE 0 END), 0) AS saldo
       FROM caja_chica_movimiento
       WHERE id_caja = ? AND estado_registro = 'ACTIVO'`,
      [idCaja],
    );
    const saldo = num(fila?.saldo);

    // El punto más bajo y CUÁNDO ocurre: sin la fecha, el mensaje de error obliga al
    // usuario a revisar el libro entero para encontrar qué corregir.
    const [bajo] = await qr.query(
      `SELECT saldo_posterior, fecha FROM caja_chica_movimiento
       WHERE id_caja = ? AND estado_registro = 'ACTIVO'
       ORDER BY saldo_posterior ASC, fecha ASC
       LIMIT 1`,
      [idCaja],
    );

    await qr.query(`UPDATE caja_chica SET saldo_actual = ?, id_usuario_mod = ? WHERE id_caja = ?`, [saldo, userId, idCaja]);

    return {
      saldo,
      minimo: bajo ? num(bajo.saldo_posterior) : saldo,
      fechaMinimo: bajo?.fecha ?? null,
    };
  }

  /**
   * El concepto es opcional, pero si viene tiene que existir y servir para ese tipo de
   * movimiento: un "Ajuste por arqueo" vale para los dos lados, "Movilidad" no es un
   * ingreso. Sin esta validación se guardan gastos etiquetados como reposiciones y el
   * reporte por concepto deja de significar algo.
   */
  private async validarConcepto(idConcepto: number | undefined, tipoMovimiento: string): Promise<number | null> {
    if (!idConcepto) return null;

    const [concepto] = await this.dataSource.query(
      `SELECT id_caja_concepto, nombre, tipo FROM caja_chica_concepto
       WHERE id_caja_concepto = ? AND estado_registro = 'ACTIVO'`,
      [idConcepto],
    );
    if (!concepto) throw new BadRequestException('El concepto seleccionado no existe o fue dado de baja');

    const esperado = tipoMovimiento === 'EGRESO' ? 'GASTO' : 'INGRESO';
    if (concepto.tipo !== 'AMBOS' && concepto.tipo !== esperado) {
      throw new BadRequestException(
        `El concepto "${concepto.nombre}" es de tipo ${concepto.tipo} y no se puede usar en un ${tipoMovimiento.toLowerCase()}.`,
      );
    }
    return Number(concepto.id_caja_concepto);
  }

  // ==========================================================
  // COMPROBANTES
  // ==========================================================

  /**
   * Manda el comprobante de un movimiento al navegador.
   *
   * La ruta se lee de la BD por el id del movimiento, nunca del query string: si el
   * frontend mandara la ruta, cualquiera podría pedir un archivo de otra empresa (o
   * de fuera de la carpeta) con solo escribirla.
   */
  async descargarComprobante(idMovimiento: number, res: Response) {
    const [mov] = await this.dataSource.query(
      `SELECT ruta_comprobante, nombre_comprobante FROM caja_chica_movimiento
       WHERE id_movimiento = ? AND estado_registro = 'ACTIVO'`,
      [idMovimiento],
    );
    if (!mov) throw new NotFoundException('Movimiento no encontrado');
    if (!mov.ruta_comprobante) throw new NotFoundException('Este movimiento no tiene comprobante adjunto');

    this.archivoService.enviar(mov.ruta_comprobante, mov.nombre_comprobante, res);
  }

  // ==========================================================
  // EXPORTACIONES
  // ==========================================================

  async exportarExcel(query: any, res: Response) {
    const data = (await this.findAll(query, true)) as any[];

    const columnas = [
      { header: 'ID', key: 'id_caja', width: 8 },
      { header: 'Empresa', key: 'razon_social', width: 40 },
      { header: 'RUC', key: 'ruc', width: 14 },
      { header: 'Caja', key: 'nombre', width: 28 },
      { header: 'Responsable', key: 'responsable', width: 24 },
      { header: 'Apertura', key: 'fecha_apertura', width: 12 },
      { header: 'Cierre', key: 'fecha_cierre', width: 12 },
      { header: 'Fondo inicial', key: 'monto_inicial', width: 14 },
      { header: 'Ingresos', key: 'total_ingresos', width: 14 },
      { header: 'Egresos', key: 'total_egresos', width: 14 },
      { header: 'Saldo actual', key: 'saldo_actual', width: 14 },
      { header: 'Estado', key: 'estado', width: 12 },
      { header: 'Observaciones', key: 'observaciones', width: 40 },
    ];

    // Los montos van como NÚMERO, no como texto con "S/": en Excel el usuario los va a
    // sumar, y una columna de strings no se suma.
    const filas = data.map((c) => ({
      ...c,
      fecha_apertura: fechaPe(c.fecha_apertura),
      fecha_cierre: fechaPe(c.fecha_cierre),
      monto_inicial: num(c.monto_inicial),
      total_ingresos: num(c.total_ingresos),
      total_egresos: num(c.total_egresos),
      saldo_actual: num(c.saldo_actual),
      responsable: c.responsable || '—',
      observaciones: c.observaciones || '—',
    }));

    await this.excelService.generarExcel(columnas, filas, `Cajas_${new Date().toISOString().split('T')[0]}`, 'Cajas', res);
  }

  async exportarPdf(query: any, res: Response) {
    const data = (await this.findAll(query, true)) as any[];

    const body = [
      ['EMPRESA', 'CAJA', 'APERTURA', 'FONDO', 'INGRESOS', 'EGRESOS', 'SALDO', 'ESTADO'].map((text) => ({
        text, bold: true, fontSize: 8,
      })),
      ...data.map((c) => [
        { text: c.razon_social ?? '', fontSize: 7.5 },
        { text: c.nombre ?? '', fontSize: 7.5 },
        { text: fechaPe(c.fecha_apertura), fontSize: 7.5 },
        { text: soles(c.monto_inicial), fontSize: 7.5, alignment: 'right' as const },
        { text: soles(c.total_ingresos), fontSize: 7.5, alignment: 'right' as const },
        { text: soles(c.total_egresos), fontSize: 7.5, alignment: 'right' as const },
        { text: soles(c.saldo_actual), fontSize: 7.5, alignment: 'right' as const, bold: true },
        { text: c.estado ?? '', fontSize: 7.5 },
      ]),
      [
        // Las celdas vacías que siguen a un colSpan son obligatorias en pdfmake: la
        // fila necesita tantas celdas como columnas, aunque queden tapadas.
        { text: `TOTAL (${data.length})`, bold: true, fontSize: 8, colSpan: 3 }, { text: '' }, { text: '' },
        { text: soles(data.reduce((a, c) => a + num(c.monto_inicial), 0)), bold: true, fontSize: 8, alignment: 'right' as const },
        { text: soles(data.reduce((a, c) => a + num(c.total_ingresos), 0)), bold: true, fontSize: 8, alignment: 'right' as const },
        { text: soles(data.reduce((a, c) => a + num(c.total_egresos), 0)), bold: true, fontSize: 8, alignment: 'right' as const },
        { text: soles(data.reduce((a, c) => a + num(c.saldo_actual), 0)), bold: true, fontSize: 8, alignment: 'right' as const },
        { text: '' },
      ],
    ];

    await this.pdfService.generarPdf(
      {
        pageOrientation: 'landscape',
        pageMargins: [25, 25, 25, 25],
        content: [
          { text: 'Cajas chicas', fontSize: 14, bold: true },
          { text: `Generado el ${new Date().toLocaleString('es-PE')}`, fontSize: 9, color: '#333333', margin: [0, 2, 0, 12] },
          {
            table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'], body },
            layout: pdfLayoutBordeado('#dddddd'),
          },
        ],
        defaultStyle: { font: 'Helvetica' },
      },
      `cajas-${new Date().toISOString().split('T')[0]}`,
      res,
    );
  }

  /**
   * Estado de cuenta de UNA caja.
   *
   * Recibe el mismo `query` de fechas que la pantalla: lo descargado tiene que cuadrar
   * con lo que el usuario está viendo, no traer siempre el histórico completo.
   */
  async exportarDetalleExcel(idCaja: number, query: any, res: Response) {
    const caja = await this.findOne(idCaja);
    const movimientos = (await this.findMovimientos(idCaja, query, true)) as any[];

    const columnas = [
      { header: 'Fecha', key: 'fecha', width: 12 },
      { header: 'Tipo', key: 'tipo', width: 10 },
      { header: 'Concepto', key: 'nombre_concepto', width: 28 },
      { header: 'Descripción', key: 'descripcion', width: 45 },
      { header: 'Medio de pago', key: 'medio_pago', width: 16 },
      { header: 'Comprobante', key: 'comprobante', width: 24 },
      { header: 'Ingreso', key: 'ingreso', width: 14 },
      { header: 'Egreso', key: 'egreso', width: 14 },
      { header: 'Saldo', key: 'saldo_posterior', width: 14 },
      { header: 'Estado', key: 'estado', width: 12 },
      { header: 'Registró', key: 'usuario_registra', width: 24 },
    ];

    // Un ANULADO va con importe 0 en las columnas de plata: la fila se conserva para
    // que se vea que existió, pero sumar su monto descuadraría el total contra el
    // saldo real de la caja.
    const filas = movimientos.map((m) => {
      const anulado = m.estado === 'ANULADO';
      return {
        fecha: fechaPe(m.fecha),
        tipo: m.tipo,
        nombre_concepto: m.nombre_concepto || (m.tabla_origen === ORIGEN_APERTURA ? 'APERTURA DE CAJA' : '—'),
        descripcion: m.descripcion || '—',
        medio_pago: String(m.medio_pago || '').replace(/_/g, ' / '),
        comprobante: [m.tipo_comprobante !== 'NINGUNO' ? m.tipo_comprobante : null, m.nro_comprobante].filter(Boolean).join(' ') || '—',
        ingreso: !anulado && m.tipo === 'INGRESO' ? num(m.monto) : 0,
        egreso: !anulado && m.tipo === 'EGRESO' ? num(m.monto) : 0,
        saldo_posterior: num(m.saldo_posterior),
        estado: anulado ? `ANULADO — ${m.motivo_anulacion || 'sin motivo'}` : 'REGISTRADO',
        usuario_registra: m.usuario_registra || '—',
      };
    });

    await this.excelService.generarExcel(
      columnas, filas, `Caja_${this.nombreArchivo(caja)}`, 'Estado de cuenta', res,
    );
  }

  async exportarDetallePdf(idCaja: number, query: any, res: Response) {
    const caja = await this.findOne(idCaja);
    const movimientos = (await this.findMovimientos(idCaja, query, true)) as any[];

    const periodo = query?.fecha_inicio || query?.fecha_fin
      ? `Periodo ${fechaPe(query.fecha_inicio) } a ${fechaPe(query.fecha_fin)}`
      : 'Histórico completo';

    const registrados = movimientos.filter((m) => m.estado === 'REGISTRADO');
    const ingresos = registrados.filter((m) => m.tipo === 'INGRESO').reduce((a, m) => a + num(m.monto), 0);
    const egresos = registrados.filter((m) => m.tipo === 'EGRESO').reduce((a, m) => a + num(m.monto), 0);

    const body = [
      ['FECHA', 'TIPO', 'CONCEPTO', 'DESCRIPCIÓN', 'COMPROBANTE', 'INGRESO', 'EGRESO', 'SALDO'].map((text) => ({
        text, bold: true, fontSize: 8,
      })),
      ...movimientos.map((m) => {
        const anulado = m.estado === 'ANULADO';
        // Gris y con la nota de anulación: se lee de un vistazo que esa fila no suma.
        const color = anulado ? '#999999' : undefined;
        return [
          { text: fechaPe(m.fecha), fontSize: 7.5, color },
          { text: m.tipo, fontSize: 7.5, color },
          { text: m.nombre_concepto || (m.tabla_origen === ORIGEN_APERTURA ? 'APERTURA DE CAJA' : '—'), fontSize: 7.5, color },
          {
            text: anulado ? `${m.descripcion || '—'} (ANULADO: ${m.motivo_anulacion || 'sin motivo'})` : m.descripcion || '—',
            fontSize: 7.5, color,
          },
          { text: [m.tipo_comprobante !== 'NINGUNO' ? m.tipo_comprobante : null, m.nro_comprobante].filter(Boolean).join(' ') || '—', fontSize: 7.5, color },
          { text: !anulado && m.tipo === 'INGRESO' ? soles(m.monto) : '', fontSize: 7.5, alignment: 'right' as const, color },
          { text: !anulado && m.tipo === 'EGRESO' ? soles(m.monto) : '', fontSize: 7.5, alignment: 'right' as const, color },
          { text: soles(m.saldo_posterior), fontSize: 7.5, alignment: 'right' as const, color },
        ];
      }),
      [
        { text: `TOTAL DEL PERIODO (${registrados.length} movimientos)`, bold: true, fontSize: 8, colSpan: 5 },
        { text: '' }, { text: '' }, { text: '' }, { text: '' },
        { text: soles(ingresos), bold: true, fontSize: 8, alignment: 'right' as const },
        { text: soles(egresos), bold: true, fontSize: 8, alignment: 'right' as const },
        { text: soles(caja.saldo_actual), bold: true, fontSize: 8, alignment: 'right' as const },
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
            text: `${periodo} · Responsable: ${caja.responsable || '—'} · Fondo inicial ${soles(caja.monto_inicial)} · Saldo actual ${soles(caja.saldo_actual)}`,
            fontSize: 9, color: '#333333', margin: [0, 4, 0, 12],
          },
          {
            table: { headerRows: 1, widths: ['auto', 'auto', 'auto', '*', 'auto', 'auto', 'auto', 'auto'], body },
            layout: pdfLayoutBordeado('#dddddd'),
          },
          // Nota al pie: solo lo que no se deduce mirando el cuadro.
          {
            text: 'Las filas en gris están anuladas y no suman al total. · El saldo corresponde a la fecha de cada movimiento.',
            fontSize: 7.5, color: '#666666', margin: [0, 10, 0, 0],
          },
        ],
        defaultStyle: { font: 'Helvetica' },
      },
      `caja-${this.nombreArchivo(caja)}`,
      res,
    );
  }

  /** Nombre de archivo legible y sin caracteres que rompan la descarga en Windows. */
  private nombreArchivo(caja: any): string {
    return `${String(caja.nombre || 'Caja').replace(/[^a-zA-Z0-9]+/g, '_')}_${caja.id_caja}`;
  }
}

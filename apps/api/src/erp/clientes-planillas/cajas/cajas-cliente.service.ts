import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { PdfService, pdfLayoutBordeado } from '@app/common';
import { AuditoriaService } from '@app/common';
import { CajasArchivoService } from '../../estudio-barba/tesoreria/cajas/cajas-archivo.service';
import {
  ORIGEN_APERTURA, cuentaParaSaldo, num, soles, fechaPe,
  bloquearCaja, recalcularSaldos, validarConcepto,
} from '../../estudio-barba/tesoreria/cajas/cajas-saldos';
import { resolverEmpresaDelUsuario } from '../scope-empresa';
import {
  CreateCajaClienteDto, UpdateCajaClienteDto, CreateMovimientoCajaClienteDto,
  UpdateMovimientoCajaClienteDto, AnularMovimientoCajaClienteDto,
} from './dto/caja-cliente.dto';

/**
 * Con alias porque las consultas de acá unen `caja_chica` con `caja_chica_movimiento`:
 * las dos tienen `estado` y `estado_registro`, y sin el prefijo MySQL corta con
 * "Column 'estado' in field list is ambiguous".
 */
const CUENTA_PARA_SALDO = cuentaParaSaldo('m');

/**
 * Tope de cajas ABIERTAS a la vez por empresa.
 *
 * No es una regla contable: es el freno a que una cuenta del portal llene la base con
 * cajas de prueba. Diez alcanza de sobra para el caso real (oficina, obra, sucursal) y
 * el mensaje dice qué hacer al llegar. Las CERRADAS no cuentan: son historia.
 */
const MAX_CAJAS_ABIERTAS_CLIENTE = 10;

/**
 * Hoy en 'YYYY-MM-DD' y en la hora del SERVIDOR, que es la que usa MySQL con CURDATE().
 * Se arma a mano y no con `toISOString()`: ese convierte a UTC y en Perú (UTC-5)
 * devuelve el día siguiente desde las 19:00, con lo que la validación de "fecha futura"
 * dejaría pasar mañana todas las noches durante cinco horas.
 */
const hoyIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Caja chica — PORTAL CLIENTE.
 *
 * Es la MISMA caja chica de `tesoreria/cajas`, no una versión recortada: la empresa la
 * abre, la corrige, registra sus gastos y sus reposiciones, anula lo que cargó mal,
 * arquea y la cierra. La caja es suya y el estudio valida por su lado, en su sistema.
 *
 * Lo único que este service agrega sobre la caja de la intranet es el SCOPE: toda
 * consulta empieza resolviendo la empresa del token y la mete en el WHERE. Por eso no se
 * reusa `CajasService` —que no filtra por ninguna— y por eso todo método recibe `user`.
 *
 * El cálculo del saldo, en cambio, SÍ se comparte (`cajas-saldos.ts`). Es deliberado:
 * las dos pantallas mueven la misma plata, y dos implementaciones de "cuánto queda" es
 * cómo el cliente y el contador terminan viendo números distintos.
 */
@Injectable()
export class CajasClienteService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private archivoService: CajasArchivoService,
    private pdfService: PdfService,
  ) {}

  // ==========================================================
  // CONSULTAS
  // ==========================================================

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
              COALESCE(SUM(CASE WHEN m.estado = 'REGISTRADO' THEN 1 ELSE 0 END), 0) AS total_movimientos
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
              COALESCE(SUM(CASE WHEN m.estado = 'REGISTRADO' THEN 1 ELSE 0 END), 0) AS total_movimientos
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

  /**
   * Catálogo de conceptos — el mismo que la intranet, completo. Es global y no tiene
   * datos de nadie. Van los de INGRESO también: la empresa repone su propio fondo y
   * ajusta por arqueo, así que necesita las dos mitades del catálogo.
   */
  findConceptos() {
    return this.dataSource.query(
      `SELECT c.id_caja_concepto, c.codigo, c.nombre, c.tipo
       FROM caja_chica_concepto c
       WHERE c.estado_registro = 'ACTIVO'
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
    // `< fecha_fin + 1 día` y no `<=`: si algún día la columna pasa a DATETIME, un `<=`
    // se comería el último día completo.
    if (query.fecha_fin) { where.push('m.fecha < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(query.fecha_fin); }
    if (query.tipo === 'INGRESO' || query.tipo === 'EGRESO') { where.push('m.tipo = ?'); params.push(query.tipo); }
    // Los anulados se muestran por defecto (atenuados) porque son parte del rastro; se
    // esconden cuando lo que se quiere es leer solo la plata real.
    if (query.ocultarAnulados === 'true') where.push("m.estado = 'REGISTRADO'");

    const whereSql = where.join(' AND ');

    const sqlData = `
      SELECT m.id_movimiento, m.tipo, m.fecha, m.monto, m.medio_pago,
             m.saldo_anterior, m.saldo_posterior, m.descripcion,
             m.tipo_comprobante, m.nro_comprobante, m.ruta_comprobante, m.nombre_comprobante,
             m.tabla_origen, m.estado, m.motivo_anulacion,
             m.id_caja_concepto, c.nombre AS nombre_concepto
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

  // ==========================================================
  // ABRIR / CORREGIR / CERRAR
  // ==========================================================

  /**
   * Abre una caja chica para SU empresa, con su fondo ya disponible.
   *
   * Los dos INSERT van en la misma transacción: una caja con `monto_inicial = 500` y sin
   * su movimiento de apertura muestra un saldo de 500 que el estado de cuenta no puede
   * explicar. La apertura es un INGRESO como cualquier otro — por eso el saldo cuadra
   * con `total_ingresos - total_egresos` sin ninguna derivación aparte.
   */
  async crearCaja(user: any, dto: CreateCajaClienteDto, userId: number) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    // La empresa tiene que seguir siendo cliente ACTIVO. El token puede haberse firmado
    // antes de que el estudio le diera de baja, y una cuenta que quedó viva no abre
    // cajas nuevas. Es 403 y no 404: la empresa existe, lo que no tiene es habilitación.
    const [empresa] = await this.dataSource.query(
      `SELECT id_empresa FROM empresa
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO' AND estado_cliente = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!empresa) {
      throw new ForbiddenException(
        'Tu empresa no figura como cliente activo del estudio, así que no puede abrir cajas. Consultá con el estudio.',
      );
    }

    const nombre = dto.nombre.trim();
    const responsable = dto.responsable?.trim() || null;
    const observaciones = dto.observaciones?.trim() || null;
    const montoInicial = num(dto.monto_inicial);
    const fechaApertura = String(dto.fecha_apertura).slice(0, 10);

    // Una caja abierta "mañana" deja todo gasto anterior a esa fecha por debajo del
    // fondo, y el recálculo los va a rechazar por saldo negativo sin que se entienda por
    // qué. Se corta acá, donde el mensaje todavía puede explicarlo.
    if (fechaApertura > hoyIso()) {
      throw new BadRequestException('La caja no se puede abrir con una fecha futura: poné el día en que entregaste el fondo.');
    }

    const [{ total: abiertas }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM caja_chica
       WHERE id_empresa = ? AND estado = 'ABIERTA' AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (Number(abiertas) >= MAX_CAJAS_ABIERTAS_CLIENTE) {
      throw new BadRequestException(
        `Ya tenés ${abiertas} cajas abiertas, que es el máximo. Cerrá las que ya no usás y volvé a intentar.`,
      );
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const res: any = await qr.query(
        `INSERT INTO caja_chica
          (id_empresa, nombre, responsable, monto_inicial, saldo_actual, estado,
           fecha_apertura, observaciones, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, 'ABIERTA', ?, ?, 'ACTIVO', ?)`,
        [idEmpresa, nombre, responsable, montoInicial, montoInicial, fechaApertura, observaciones, userId],
      );
      const idCaja = Number(res.insertId);

      await qr.query(
        `INSERT INTO caja_chica_movimiento
          (id_caja, tipo, fecha, monto, medio_pago, saldo_anterior, saldo_posterior,
           descripcion, tipo_comprobante, tabla_origen, estado, estado_registro, id_usuario_crea)
         VALUES (?, 'INGRESO', ?, ?, 'EFECTIVO', 0, ?, ?, 'NINGUNO', ?, 'REGISTRADO', 'ACTIVO', ?)`,
        [idCaja, fechaApertura, montoInicial, montoInicial, 'Apertura de caja — fondo inicial', ORIGEN_APERTURA, userId],
      );

      await this.auditoriaService.registrarConTransaccion(qr, 'caja_chica', idCaja, 'CREAR', userId, null, {
        ...dto, nombre, responsable, observaciones, id_empresa: idEmpresa, origen: 'PORTAL_CLIENTE',
      });

      await qr.commitTransaction();
      return { id: idCaja, mensaje: 'Caja abierta correctamente' };
    } catch (error: any) {
      await qr.rollbackTransaction();
      // El UNIQUE es (id_empresa, nombre) y sigue ocupado aunque la caja esté eliminada:
      // decir solo "ya existe" deja al cliente probando el mismo nombre otra vez.
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException(
          `Ya tenés una caja llamada "${nombre}". Ponele otro nombre (por ejemplo el local o el área) para poder distinguirlas.`,
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
   * Cambiar el fondo toca el movimiento de apertura y, con él, toda la cadena de saldos:
   * por eso se sincronizan los tres (cabecera, apertura y saldos corridos) dentro de la
   * misma transacción. Se rechaza si el resultado deja la caja en negativo en cualquier
   * punto de su historia, no solo al final.
   */
  async actualizarCaja(user: any, idCaja: number, dto: UpdateCajaClienteDto, userId: number) {
    const anterior = await this.findOne(user, idCaja); // valida pertenencia y da los old values

    const nombre = dto.nombre.trim();
    const responsable = dto.responsable?.trim() || null;
    const observaciones = dto.observaciones?.trim() || null;
    const montoNuevo = num(dto.monto_inicial);
    const fechaApertura = String(dto.fecha_apertura).slice(0, 10);

    if (fechaApertura > hoyIso()) {
      throw new BadRequestException('La fecha de apertura no puede ser futura.');
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const caja = await bloquearCaja(qr, idCaja, false);
      if (caja.estado === 'CERRADA') {
        throw new BadRequestException(
          'Esta caja está cerrada y ya no se puede corregir. Si el fondo estaba mal, abrí una caja nueva con el monto correcto.',
        );
      }

      await qr.query(
        `UPDATE caja_chica
         SET nombre = ?, responsable = ?, monto_inicial = ?,
             fecha_apertura = ?, observaciones = ?, id_usuario_mod = ?
         WHERE id_caja = ? AND estado_registro = 'ACTIVO'`,
        [nombre, responsable, montoNuevo, fechaApertura, observaciones, userId, idCaja],
      );

      // El movimiento de apertura tiene que reflejar el mismo monto y la misma fecha: es
      // la primera línea del estado de cuenta y sin esto seguiría diciendo el monto
      // viejo. No se exige que el UPDATE afecte filas: una caja migrada a mano podría no
      // tenerlo, y eso no es motivo para abortar.
      await qr.query(
        `UPDATE caja_chica_movimiento
         SET monto = ?, fecha = ?, id_usuario_mod = ?
         WHERE id_caja = ? AND tabla_origen = ? AND estado_registro = 'ACTIVO'`,
        [montoNuevo, fechaApertura, userId, idCaja, ORIGEN_APERTURA],
      );

      const { saldo: saldoFinal, minimo, fechaMinimo } = await recalcularSaldos(qr, idCaja, userId);

      if (minimo < 0) {
        throw new BadRequestException(
          `Con un fondo inicial de ${soles(montoNuevo)} la caja quedaría en ${soles(minimo)} al ${fechaPe(fechaMinimo)}: ` +
            'para esa fecha ya se había gastado más de ese fondo. Subí el fondo o anulá primero los movimientos que estén mal.',
        );
      }

      await this.auditoriaService.registrarConTransaccion(qr, 'caja_chica', idCaja, 'ACTUALIZAR', userId, anterior, {
        ...dto, nombre, responsable, observaciones, saldo_actual: saldoFinal,
      });

      await qr.commitTransaction();
      return { id: idCaja, saldo_actual: saldoFinal, mensaje: 'Caja actualizada correctamente' };
    } catch (error: any) {
      await qr.rollbackTransaction();
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException(`Ya tenés otra caja llamada "${nombre}".`);
      }
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * Cierra la caja: deja de aceptar movimientos.
   *
   * No se exige saldo cero. Una caja se cierra con lo que le haya quedado y ese saldo es
   * justamente el dato de la rendición — obligar a "cuadrar en cero" solo empuja a
   * inventar un movimiento de ajuste.
   */
  async cerrarCaja(user: any, idCaja: number, userId: number) {
    const caja = await this.findOne(user, idCaja);
    if (caja.estado === 'CERRADA') throw new BadRequestException('Esta caja ya está cerrada');

    const res: any = await this.dataSource.query(
      `UPDATE caja_chica SET estado = 'CERRADA', fecha_cierre = CURDATE(), id_usuario_mod = ?
       WHERE id_caja = ? AND estado = 'ABIERTA' AND estado_registro = 'ACTIVO'`,
      [userId, idCaja],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Caja no encontrada');

    await this.auditoriaService.registrar('caja_chica', idCaja, 'ACTUALIZAR', userId, caja, { estado: 'CERRADA' });
    return { id: idCaja, mensaje: `Caja cerrada con un saldo de ${soles(caja.saldo_actual)}` };
  }

  // ==========================================================
  // MOVIMIENTOS
  // ==========================================================

  /**
   * Registra un gasto o una reposición de fondo en SU caja.
   *
   * El orden es: bloquear → insertar → recalcular → validar. Validar DESPUÉS de escribir
   * parece al revés, pero es lo correcto: el movimiento puede entrar con fecha
   * retroactiva (la boleta apareció una semana después), así que su efecto sobre el
   * saldo no se conoce hasta rearmar la cadena completa. Si el resultado no sirve, el
   * rollback deshace el INSERT y no queda rastro.
   */
  async crearMovimiento(user: any, dto: CreateMovimientoCajaClienteDto, userId: number) {
    await this.findOne(user, dto.id_caja); // la caja es suya, o 404 antes de tocar nada

    const idConcepto = await validarConcepto(this.dataSource, dto.id_caja_concepto, dto.tipo);
    const monto = num(dto.monto);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const caja = await bloquearCaja(qr, dto.id_caja);
      const saldoPrevio = num(caja.saldo_actual);

      const res: any = await qr.query(
        `INSERT INTO caja_chica_movimiento
          (id_caja, id_caja_concepto, tipo, fecha, monto, medio_pago,
           descripcion, tipo_comprobante, nro_comprobante, ruta_comprobante, nombre_comprobante,
           estado, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTRADO', 'ACTIVO', ?)`,
        [
          dto.id_caja, idConcepto, dto.tipo, dto.fecha, monto, dto.medio_pago ?? 'EFECTIVO',
          dto.descripcion.trim(),
          dto.tipo_comprobante ?? 'NINGUNO',
          dto.nro_comprobante?.trim() || null,
          dto.ruta_comprobante || null,
          dto.nombre_comprobante?.trim() || null,
          userId,
        ],
      );
      const idMovimiento = Number(res.insertId);

      // `saldo_anterior`/`saldo_posterior` no se calculan en el INSERT: los pone el
      // recálculo, que es el único que conoce la posición real de este movimiento dentro
      // de la cadena una vez ordenada por fecha.
      const { saldo: saldoFinal, minimo, fechaMinimo } = await recalcularSaldos(qr, dto.id_caja, userId);

      if (minimo < 0) {
        throw new BadRequestException(
          `Este gasto de ${soles(monto)} deja la caja en ${soles(minimo)} al ${fechaPe(fechaMinimo)}: en esa fecha no había ese saldo. ` +
            `Hoy la caja tiene ${soles(saldoPrevio)}. Si el gasto es correcto, registrá antes la reposición del fondo con su fecha real.`,
        );
      }

      await this.auditoriaService.registrarConTransaccion(
        qr, 'caja_chica_movimiento', idMovimiento, 'CREAR', userId, null, { ...dto, monto, origen: 'PORTAL_CLIENTE' },
      );

      await qr.commitTransaction();
      return {
        id: idMovimiento,
        saldo_actual: saldoFinal,
        mensaje: dto.tipo === 'INGRESO' ? 'Reposición registrada correctamente' : 'Gasto registrado correctamente',
      };
    } catch (error) {
      await qr.rollbackTransaction();
      // La subida es un paso aparte del guardado: si el INSERT falla, el archivo ya está
      // en disco y sin esto queda huérfano para siempre.
      this.archivoService.borrarSiExiste(dto.ruta_comprobante);
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * Corrige un movimiento ya registrado y rearma la cadena de saldos.
   *
   * El tipo y la caja no se tocan (no están en el DTO). Un movimiento ANULADO tampoco se
   * edita: su efecto ya se revirtió y volver a tocarlo movería un saldo que él ya no
   * sostiene.
   */
  async actualizarMovimiento(user: any, idMovimiento: number, dto: UpdateMovimientoCajaClienteDto, userId: number) {
    const montoNuevo = num(dto.monto);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const mov = await this.movimientoDeSuEmpresa(qr, user, idMovimiento);

      if (mov.tabla_origen === ORIGEN_APERTURA) {
        throw new BadRequestException(
          'Este es el fondo con el que abriste la caja. Para corregirlo, editá la caja: así se ajustan a la vez el monto inicial y el saldo.',
        );
      }
      if (mov.estado === 'ANULADO') {
        throw new BadRequestException('Este movimiento está anulado. Registrá uno nuevo en lugar de editarlo.');
      }

      const caja = await bloquearCaja(qr, mov.id_caja);
      const saldoPrevio = num(caja.saldo_actual);

      const idConcepto = await validarConcepto(this.dataSource, dto.id_caja_concepto, mov.tipo);

      // El comprobante nuevo reemplaza al anterior; si no se mandó ninguno, se conserva
      // el que ya estaba (editar el monto no debe borrar la boleta).
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
          dto.descripcion.trim(),
          dto.tipo_comprobante ?? mov.tipo_comprobante,
          dto.nro_comprobante?.trim() || null,
          rutaNueva, nombreNuevo,
          userId, idMovimiento,
        ],
      );

      // Cambiar la FECHA reordena la cadena, así que los saldos no se ajustan: se rearman
      // enteros. Es también lo que mantiene alineada la columna SALDO del estado de
      // cuenta cuando la corrección cae en medio de la historia.
      const { saldo: saldoFinal, minimo, fechaMinimo } = await recalcularSaldos(qr, mov.id_caja, userId);

      if (minimo < 0) {
        throw new BadRequestException(
          `Con ${soles(montoNuevo)} la caja quedaría en ${soles(minimo)} al ${fechaPe(fechaMinimo)}: en esa fecha no había ese saldo. ` +
            `Hoy la caja tiene ${soles(saldoPrevio)}.`,
        );
      }

      await this.auditoriaService.registrarConTransaccion(
        qr, 'caja_chica_movimiento', idMovimiento, 'ACTUALIZAR', userId, mov, { ...dto, monto: montoNuevo },
      );

      await qr.commitTransaction();

      // Recién con el commit hecho: si se borrara antes y la transacción fallara, el
      // movimiento seguiría apuntando a un archivo que ya no está.
      if (dto.ruta_comprobante && mov.ruta_comprobante && dto.ruta_comprobante !== mov.ruta_comprobante) {
        this.archivoService.borrarSiExiste(mov.ruta_comprobante);
      }

      return { id: idMovimiento, saldo_actual: saldoFinal, mensaje: 'Movimiento actualizado correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      this.archivoService.borrarSiExiste(dto.ruta_comprobante);
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
  async anularMovimiento(user: any, idMovimiento: number, dto: AnularMovimientoCajaClienteDto, userId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const mov = await this.movimientoDeSuEmpresa(qr, user, idMovimiento);

      if (mov.tabla_origen === ORIGEN_APERTURA) {
        throw new BadRequestException(
          'El fondo de apertura no se anula: es la caja misma. Si la caja no debía existir, cerrala.',
        );
      }
      if (mov.estado === 'ANULADO') throw new BadRequestException('Este movimiento ya está anulado');

      await bloquearCaja(qr, mov.id_caja);

      await qr.query(
        `UPDATE caja_chica_movimiento
         SET estado = 'ANULADO', motivo_anulacion = ?, id_usuario_anula = ?, id_usuario_mod = ?
         WHERE id_movimiento = ? AND estado = 'REGISTRADO' AND estado_registro = 'ACTIVO'`,
        [dto.motivo.trim(), userId, userId, idMovimiento],
      );

      // Un ANULADO entra en la cadena con delta 0: la fila queda visible con su motivo,
      // pero deja de mover plata y todos los saldos posteriores se corren solos.
      const { saldo: saldoFinal, minimo, fechaMinimo } = await recalcularSaldos(qr, mov.id_caja, userId);

      if (minimo < 0) {
        throw new BadRequestException(
          `Anular esta reposición de ${soles(mov.monto)} deja la caja en ${soles(minimo)} al ${fechaPe(fechaMinimo)}: esa plata ya se gastó. ` +
            'Anulá primero los gastos que salieron de ella.',
        );
      }

      await this.auditoriaService.registrarConTransaccion(qr, 'caja_chica_movimiento', idMovimiento, 'ANULAR', userId, mov, null);

      await qr.commitTransaction();
      return { id: idMovimiento, saldo_actual: saldoFinal, mensaje: 'Movimiento anulado correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * El movimiento, siempre que su caja sea de la empresa del token.
   *
   * El `id_empresa` entra en el JOIN, no en un `if` después de leer: sin eso, un id de
   * movimiento de otra empresa se podría editar o anular con solo escribirlo en la URL.
   * Va con `FOR UPDATE` porque quien lo llama está por modificarlo dentro de la misma
   * transacción.
   */
  private async movimientoDeSuEmpresa(qr: any, user: any, idMovimiento: number): Promise<any> {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const [mov] = await qr.query(
      `SELECT m.* FROM caja_chica_movimiento m
       INNER JOIN caja_chica cc ON cc.id_caja = m.id_caja
       WHERE m.id_movimiento = ? AND cc.id_empresa = ?
         AND m.estado_registro = 'ACTIVO' AND cc.estado_registro = 'ACTIVO'
       FOR UPDATE`,
      [idMovimiento, idEmpresa],
    );
    if (!mov) throw new NotFoundException('Movimiento no encontrado');
    return mov;
  }

  // ==========================================================
  // COMPROBANTES Y REPORTES
  // ==========================================================

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
   * Estado de cuenta de SU caja en PDF: el papel del arqueo.
   *
   * Lleva la columna SALDO corrido porque es lo que se compara contra el efectivo
   * contado, y cierra con el arqueo (fondo + ingresos − egresos = saldo) para que quien
   * firma pueda verificar la resta sin rehacerla aparte.
   */
  async exportarPdf(user: any, idCaja: number, query: any, res: Response) {
    const caja = await this.findOne(user, idCaja);
    const movimientos = (await this.findMovimientos(user, idCaja, query, true)) as any[];

    const periodo = query?.fecha_inicio || query?.fecha_fin
      ? `Periodo ${fechaPe(query.fecha_inicio)} a ${fechaPe(query.fecha_fin)}`
      : 'Histórico completo';

    const cuenta = (m: any) => m.estado === 'REGISTRADO';
    const vivos = movimientos.filter(cuenta);
    const ingresos = vivos.filter((m) => m.tipo === 'INGRESO').reduce((a, m) => a + num(m.monto), 0);
    const egresos = vivos.filter((m) => m.tipo === 'EGRESO').reduce((a, m) => a + num(m.monto), 0);
    const anulados = movimientos.length - vivos.length;

    const body = [
      ['FECHA', 'CONCEPTO', 'DESCRIPCIÓN', 'COMPROBANTE', 'INGRESO', 'EGRESO', 'SALDO'].map((text) => ({
        text, bold: true, fontSize: 8,
      })),
      ...movimientos.map((m) => {
        const suma = cuenta(m);
        // Un anulado se muestra atenuado: es parte del rastro, pero no es plata.
        const color = suma ? undefined : '#999999';
        return [
          { text: fechaPe(m.fecha), fontSize: 7.5, color },
          { text: m.nombre_concepto || (m.tabla_origen === ORIGEN_APERTURA ? 'Apertura de caja' : '—'), fontSize: 7.5, color },
          {
            text: m.estado === 'ANULADO'
              ? `${m.descripcion || '—'} · ANULADO: ${m.motivo_anulacion || 'sin motivo'}`
              : m.descripcion || '—',
            fontSize: 7.5, color,
          },
          { text: [m.tipo_comprobante !== 'NINGUNO' ? m.tipo_comprobante : null, m.nro_comprobante].filter(Boolean).join(' ') || '—', fontSize: 7.5, color },
          { text: suma && m.tipo === 'INGRESO' ? soles(m.monto) : '', fontSize: 7.5, alignment: 'right' as const, color },
          { text: suma && m.tipo === 'EGRESO' ? soles(m.monto) : '', fontSize: 7.5, alignment: 'right' as const, color },
          // Un movimiento que no cuenta no tiene saldo propio: mostrar el de la caja al
          // lado de una fila que no la movió es engañoso.
          { text: suma ? soles(m.saldo_posterior) : '—', fontSize: 7.5, alignment: 'right' as const, color },
        ];
      }),
      [
        { text: `TOTALES (${vivos.length} movimientos)`, bold: true, fontSize: 8, colSpan: 4 },
        { text: '' }, { text: '' }, { text: '' },
        { text: soles(ingresos), bold: true, fontSize: 8, alignment: 'right' as const },
        { text: soles(egresos), bold: true, fontSize: 8, alignment: 'right' as const },
        { text: soles(ingresos - egresos), bold: true, fontSize: 8, alignment: 'right' as const },
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
            text: `${periodo} · Responsable: ${caja.responsable || '—'} · Caja ${caja.estado} · Saldo ${soles(caja.saldo_actual)}`,
            fontSize: 9, color: '#333333', margin: [0, 4, 0, 12],
          },
          {
            table: { headerRows: 1, widths: ['auto', 'auto', '*', 'auto', 'auto', 'auto', 'auto'], body },
            layout: pdfLayoutBordeado('#dddddd'),
          },
          // El arqueo: lo que hay que contar en efectivo y con qué cuadrarlo. Va como
          // recuadro aparte porque es lo que se firma, no una fila más del cuadro.
          {
            margin: [0, 14, 0, 0],
            table: {
              widths: ['*', 'auto'],
              body: [
                [{ text: 'ARQUEO DE CAJA', bold: true, fontSize: 9, colSpan: 2 }, { text: '' }],
                [{ text: 'Fondo inicial', fontSize: 8 }, { text: soles(caja.monto_inicial), fontSize: 8, alignment: 'right' as const }],
                [{ text: 'Más: ingresos y reposiciones del periodo', fontSize: 8 }, { text: soles(ingresos - num(caja.monto_inicial)), fontSize: 8, alignment: 'right' as const }],
                [{ text: 'Menos: gastos del periodo', fontSize: 8 }, { text: soles(egresos), fontSize: 8, alignment: 'right' as const }],
                [{ text: 'SALDO QUE DEBE HABER EN LA CAJA', bold: true, fontSize: 9 }, { text: soles(ingresos - egresos), bold: true, fontSize: 9, alignment: 'right' as const }],
                [{ text: 'Efectivo contado', fontSize: 8 }, { text: '____________', fontSize: 8, alignment: 'right' as const }],
                [{ text: 'Diferencia', fontSize: 8 }, { text: '____________', fontSize: 8, alignment: 'right' as const }],
              ],
            },
            layout: pdfLayoutBordeado('#dddddd'),
          },
          {
            text: [
              'Responsable: ______________________     Revisado por: ______________________',
              anulados ? `\n${anulados} movimiento(s) anulado(s) figuran en gris y no entran en los totales.` : '',
            ].join(''),
            fontSize: 7.5, color: '#666666', margin: [0, 16, 0, 0],
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
      'total_movimientos', 'monto', 'saldo_anterior', 'saldo_posterior']) {
      if (fila?.[campo] !== undefined && fila[campo] !== null) fila[campo] = Number(fila[campo]);
    }
    return fila;
  }
}

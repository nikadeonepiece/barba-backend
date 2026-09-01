import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditoriaService } from '@app/common';
import { CredencialesCryptoService } from '@app/security';
import { SunatTregistroClient } from './sunat-tregistro.client';
import { SunatTregistroScrapingClient } from './sunat-tregistro-scraping.client';
import {
  CreateTrabajadorDto, UpdateTrabajadorDto, CesarTrabajadorDto,
  CreateRemuneracionDto, CreateConceptoFijoDto, UpdateConceptoFijoDto,
  UpdateEmpresaConfigDto,
} from './dto/trabajador.dto';

const COLS_ORDER_ALLOWED = ['apellido_paterno', 'numero_documento', 'fecha_ingreso', 'cargo'];

const bit = (v: any, actual: number): number => (v === undefined || v === null ? actual : v ? 1 : 0);
const val = <T>(v: T | undefined | null, actual: T): T => (v === undefined || v === null ? actual : v);

@Injectable()
export class TrabajadoresService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private credencialesCrypto: CredencialesCryptoService,
    private sunatTregistroClient: SunatTregistroClient,
    private scrapingTregistro: SunatTregistroScrapingClient,
  ) {}

  // ==========================================================================
  // Padrón
  // ==========================================================================
  async findAll(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;

    const where: string[] = ["t.estado_registro = 'ACTIVO'"];
    const params: any[] = [];

    const idEmpresa = Number(query.id_empresa);
    if (idEmpresa) {
      where.push('t.id_empresa = ?');
      params.push(idEmpresa);
    }

    if (query.search) {
      where.push(`(t.numero_documento LIKE ? OR CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) LIKE ?)`);
      params.push(`%${query.search}%`, `%${query.search}%`);
    }

    // Por defecto solo los activos: el padrón histórico crece sin parar y lo que se
    // usa a diario es quién está en planilla ahora.
    if (query.incluirCesados !== 'true') {
      where.push("t.cod_situacion <> '00' AND t.fecha_cese IS NULL");
    }
    if (query.id_regimen) {
      where.push('t.id_regimen = ?');
      params.push(Number(query.id_regimen));
    }
    if (query.regimen_pensionario) {
      where.push('t.regimen_pensionario = ?');
      params.push(query.regimen_pensionario);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort) ? query.sort : 'apellido_paterno';
    const sortDir = query.dir === 'DESC' ? 'DESC' : 'ASC';

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT t.id_trabajador, t.id_empresa, e.razon_social, e.ruc,
                t.cod_tipo_documento, t.numero_documento,
                t.apellido_paterno, t.apellido_materno, t.nombres,
                CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_completo,
                t.cargo, t.area, t.fecha_ingreso, t.fecha_cese, t.cod_situacion,
                t.id_regimen, r.codigo AS codigo_regimen, r.nombre AS nombre_regimen,
                t.regimen_pensionario, t.id_afp, a.nombre AS nombre_afp, t.tipo_comision_afp,
                t.tiene_hijos_menores, t.afecto_sctr,
                rem.sueldo_basico, rem.vigencia_desde AS sueldo_vigente_desde
         FROM planilla_trabajador t
         JOIN empresa e ON e.id_empresa = t.id_empresa
         JOIN planilla_regimen_laboral r ON r.id_regimen = t.id_regimen
         LEFT JOIN planilla_afp a ON a.id_afp = t.id_afp AND a.estado_registro = 'ACTIVO'
         LEFT JOIN (
           SELECT x.id_trabajador, x.sueldo_basico, x.vigencia_desde
           FROM planilla_trabajador_remuneracion x
           JOIN (
             SELECT id_trabajador, MAX(vigencia_desde) AS maxv
             FROM planilla_trabajador_remuneracion
             WHERE estado_registro = 'ACTIVO' AND vigencia_desde <= CURDATE()
             GROUP BY id_trabajador
           ) m ON m.id_trabajador = x.id_trabajador AND m.maxv = x.vigencia_desde
           WHERE x.estado_registro = 'ACTIVO'
         ) rem ON rem.id_trabajador = t.id_trabajador
         ${whereSql}
         ORDER BY t.${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total FROM planilla_trabajador t ${whereSql}`, params),
    ]);

    return { data, meta: { total: Number(total), page, limit } };
  }

  async findOne(id: number) {
    const [row] = await this.dataSource.query(
      `SELECT t.*, e.razon_social, e.ruc, r.codigo AS codigo_regimen, r.nombre AS nombre_regimen
       FROM planilla_trabajador t
       JOIN empresa e ON e.id_empresa = t.id_empresa
       JOIN planilla_regimen_laboral r ON r.id_regimen = t.id_regimen
       WHERE t.id_trabajador = ? AND t.estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!row) throw new NotFoundException('Trabajador no encontrado');
    return row;
  }

  /**
   * Alta con su sueldo de ingreso, en una sola transacción.
   *
   * Van juntos a propósito: un trabajador sin remuneración no sirve para calcular
   * nada, y si el INSERT del sueldo fallara después del INSERT del trabajador,
   * quedaría un registro a medias que nadie sabría que está roto.
   */
  async create(dto: CreateTrabajadorDto, userId: number) {
    await this.validarRegimenYEmpresa(dto.id_empresa, dto.id_regimen);
    this.validarFechas(dto.fecha_ingreso, dto.fecha_cese);
    this.validarAfp(dto.regimen_pensionario, dto.id_afp, dto.tipo_comision_afp);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const res: any = await qr.query(
        `INSERT INTO planilla_trabajador
          (id_empresa, cod_tipo_documento, numero_documento, apellido_paterno, apellido_materno, nombres,
           fecha_nacimiento, sexo, cod_nacionalidad, cod_ubigeo, direccion, email, telefono,
           id_regimen, cod_regimen_laboral_sunat, cod_tipo_trabajador, cod_categoria_ocupacional,
           cod_tipo_contrato, cod_ocupacion, cod_periodicidad, cod_situacion,
           cargo, area, fecha_ingreso,
           jornada_maxima, sujeto_fiscalizacion, discapacidad, sindicalizado, tiene_hijos_menores,
           regimen_pensionario, cod_regimen_pensionario_sunat, id_afp, cuspp, tipo_comision_afp,
           fecha_afiliacion_afp, cod_regimen_salud, afecto_sctr, essalud_vida,
           id_banco_sueldo, cuenta_sueldo, cci_sueldo, id_banco_cts, cuenta_cts, cci_cts,
           observaciones, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`,
        [
          dto.id_empresa, dto.cod_tipo_documento ?? '01', dto.numero_documento.trim(),
          dto.apellido_paterno.trim(), dto.apellido_materno?.trim() ?? null, dto.nombres.trim(),
          dto.fecha_nacimiento ?? null, dto.sexo ?? null, dto.cod_nacionalidad ?? null,
          dto.cod_ubigeo ?? null, dto.direccion?.trim() ?? null, dto.email?.trim() ?? null,
          dto.telefono?.trim() ?? null,
          dto.id_regimen, dto.cod_regimen_laboral_sunat ?? '01', dto.cod_tipo_trabajador ?? null,
          dto.cod_categoria_ocupacional ?? null, dto.cod_tipo_contrato ?? '1',
          dto.cod_ocupacion ?? null, dto.cod_periodicidad ?? '01', dto.cod_situacion ?? '01',
          dto.cargo?.trim() ?? null, dto.area?.trim() ?? null, dto.fecha_ingreso,
          bit(dto.jornada_maxima, 1), bit(dto.sujeto_fiscalizacion, 1), bit(dto.discapacidad, 0),
          bit(dto.sindicalizado, 0), bit(dto.tiene_hijos_menores, 0),
          dto.regimen_pensionario ?? 'ONP', dto.cod_regimen_pensionario_sunat ?? null,
          dto.id_afp ?? null, dto.cuspp?.trim() ?? null, dto.tipo_comision_afp ?? null,
          dto.fecha_afiliacion_afp ?? null, dto.cod_regimen_salud ?? null,
          bit(dto.afecto_sctr, 0), bit(dto.essalud_vida, 0),
          dto.id_banco_sueldo ?? null, dto.cuenta_sueldo?.trim() ?? null, dto.cci_sueldo?.trim() ?? null,
          dto.id_banco_cts ?? null, dto.cuenta_cts?.trim() ?? null, dto.cci_cts?.trim() ?? null,
          dto.observaciones?.trim() ?? null, userId,
        ],
      );
      const idNuevo = Number(res.insertId);

      // El sueldo de ingreso arranca el mismo día que el vínculo laboral.
      await qr.query(
        `INSERT INTO planilla_trabajador_remuneracion
          (id_trabajador, vigencia_desde, sueldo_basico, moneda, motivo, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, 'PEN', 'INGRESO', 'ACTIVO', ?)`,
        [idNuevo, dto.fecha_ingreso, dto.sueldo_basico, userId],
      );

      await qr.commitTransaction();

      // La auditoría va DESPUÉS del commit y no dentro de la transacción: el
      // AuditoriaService de este proyecto usa su propia conexión (llama al stored
      // procedure `sis_auditoria_registrar`), así que no acepta el QueryRunner.
      // Es la misma convención que siguen los módulos hermanos.
      await this.auditoriaService.registrar('planilla_trabajador', idNuevo, 'CREAR', userId, null, dto);
      return { id: idNuevo };
    } catch (error: any) {
      await qr.rollbackTransaction();
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe un trabajador con ese número de documento en esta empresa');
      }
      throw error;
    } finally {
      await qr.release();
    }
  }

  async update(id: number, dto: UpdateTrabajadorDto, userId: number) {
    const old = await this.findOne(id);

    // La empresa no se cambia por update: mover un trabajador de empresa arrastraría
    // sus planillas y su historial de sueldos a un cliente distinto.
    if (dto.id_empresa !== undefined && Number(dto.id_empresa) !== Number(old.id_empresa)) {
      throw new BadRequestException(
        'No se puede mover un trabajador de empresa: su historial de sueldos y planillas quedaría bajo el cliente equivocado. ' +
          'Cesa el vínculo en la empresa actual y da de alta uno nuevo en la otra.',
      );
    }

    if (dto.id_regimen !== undefined) await this.validarRegimenYEmpresa(old.id_empresa, dto.id_regimen);
    this.validarFechas(val(dto.fecha_ingreso, old.fecha_ingreso), dto.fecha_cese ?? old.fecha_cese);
    this.validarAfp(
      val(dto.regimen_pensionario, old.regimen_pensionario),
      dto.id_afp === undefined ? old.id_afp : dto.id_afp,
      dto.tipo_comision_afp === undefined ? old.tipo_comision_afp : dto.tipo_comision_afp,
    );

    try {
      const res: any = await this.dataSource.query(
        `UPDATE planilla_trabajador SET
          cod_tipo_documento = ?, numero_documento = ?, apellido_paterno = ?, apellido_materno = ?, nombres = ?,
          fecha_nacimiento = ?, sexo = ?, cod_nacionalidad = ?, cod_ubigeo = ?, direccion = ?, email = ?, telefono = ?,
          id_regimen = ?, cod_regimen_laboral_sunat = ?, cod_tipo_trabajador = ?, cod_categoria_ocupacional = ?,
          cod_tipo_contrato = ?, cod_ocupacion = ?, cod_periodicidad = ?, cod_situacion = ?,
          cargo = ?, area = ?, fecha_ingreso = ?,
          jornada_maxima = ?, sujeto_fiscalizacion = ?, discapacidad = ?, sindicalizado = ?, tiene_hijos_menores = ?,
          regimen_pensionario = ?, cod_regimen_pensionario_sunat = ?, id_afp = ?, cuspp = ?, tipo_comision_afp = ?,
          fecha_afiliacion_afp = ?, cod_regimen_salud = ?, afecto_sctr = ?, essalud_vida = ?,
          id_banco_sueldo = ?, cuenta_sueldo = ?, cci_sueldo = ?, id_banco_cts = ?, cuenta_cts = ?, cci_cts = ?,
          observaciones = ?, id_usuario_mod = ?
         WHERE id_trabajador = ? AND estado_registro = 'ACTIVO'`,
        [
          val(dto.cod_tipo_documento, old.cod_tipo_documento),
          val(dto.numero_documento?.trim(), old.numero_documento),
          val(dto.apellido_paterno?.trim(), old.apellido_paterno),
          dto.apellido_materno === undefined ? old.apellido_materno : dto.apellido_materno?.trim() ?? null,
          val(dto.nombres?.trim(), old.nombres),
          dto.fecha_nacimiento === undefined ? old.fecha_nacimiento : dto.fecha_nacimiento,
          dto.sexo === undefined ? old.sexo : dto.sexo,
          dto.cod_nacionalidad === undefined ? old.cod_nacionalidad : dto.cod_nacionalidad,
          dto.cod_ubigeo === undefined ? old.cod_ubigeo : dto.cod_ubigeo,
          dto.direccion === undefined ? old.direccion : dto.direccion?.trim() ?? null,
          dto.email === undefined ? old.email : dto.email?.trim() ?? null,
          dto.telefono === undefined ? old.telefono : dto.telefono?.trim() ?? null,
          val(dto.id_regimen, old.id_regimen),
          val(dto.cod_regimen_laboral_sunat, old.cod_regimen_laboral_sunat),
          dto.cod_tipo_trabajador === undefined ? old.cod_tipo_trabajador : dto.cod_tipo_trabajador,
          dto.cod_categoria_ocupacional === undefined ? old.cod_categoria_ocupacional : dto.cod_categoria_ocupacional,
          val(dto.cod_tipo_contrato, old.cod_tipo_contrato),
          dto.cod_ocupacion === undefined ? old.cod_ocupacion : dto.cod_ocupacion,
          val(dto.cod_periodicidad, old.cod_periodicidad),
          val(dto.cod_situacion, old.cod_situacion),
          dto.cargo === undefined ? old.cargo : dto.cargo?.trim() ?? null,
          dto.area === undefined ? old.area : dto.area?.trim() ?? null,
          val(dto.fecha_ingreso, old.fecha_ingreso),
          bit(dto.jornada_maxima, old.jornada_maxima),
          bit(dto.sujeto_fiscalizacion, old.sujeto_fiscalizacion),
          bit(dto.discapacidad, old.discapacidad),
          bit(dto.sindicalizado, old.sindicalizado),
          bit(dto.tiene_hijos_menores, old.tiene_hijos_menores),
          val(dto.regimen_pensionario, old.regimen_pensionario),
          dto.cod_regimen_pensionario_sunat === undefined ? old.cod_regimen_pensionario_sunat : dto.cod_regimen_pensionario_sunat,
          dto.id_afp === undefined ? old.id_afp : dto.id_afp ?? null,
          dto.cuspp === undefined ? old.cuspp : dto.cuspp?.trim() ?? null,
          dto.tipo_comision_afp === undefined ? old.tipo_comision_afp : dto.tipo_comision_afp ?? null,
          dto.fecha_afiliacion_afp === undefined ? old.fecha_afiliacion_afp : dto.fecha_afiliacion_afp,
          dto.cod_regimen_salud === undefined ? old.cod_regimen_salud : dto.cod_regimen_salud,
          bit(dto.afecto_sctr, old.afecto_sctr),
          bit(dto.essalud_vida, old.essalud_vida),
          dto.id_banco_sueldo === undefined ? old.id_banco_sueldo : dto.id_banco_sueldo ?? null,
          dto.cuenta_sueldo === undefined ? old.cuenta_sueldo : dto.cuenta_sueldo?.trim() ?? null,
          dto.cci_sueldo === undefined ? old.cci_sueldo : dto.cci_sueldo?.trim() ?? null,
          dto.id_banco_cts === undefined ? old.id_banco_cts : dto.id_banco_cts ?? null,
          dto.cuenta_cts === undefined ? old.cuenta_cts : dto.cuenta_cts?.trim() ?? null,
          dto.cci_cts === undefined ? old.cci_cts : dto.cci_cts?.trim() ?? null,
          dto.observaciones === undefined ? old.observaciones : dto.observaciones?.trim() ?? null,
          userId, id,
        ],
      );
      if (res.affectedRows === 0) throw new NotFoundException('Trabajador no encontrado');

      await this.auditoriaService.registrar('planilla_trabajador', id, 'ACTUALIZAR', userId, old, dto);
      return { id };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe un trabajador con ese número de documento en esta empresa');
      }
      throw error;
    }
  }

  /** Cese: cambia la situación a "baja" (Tabla 15) y registra el motivo declarable. */
  async cesar(id: number, dto: CesarTrabajadorDto, userId: number) {
    const old = await this.findOne(id);

    if (new Date(dto.fecha_cese) < new Date(old.fecha_ingreso)) {
      throw new BadRequestException('La fecha de cese no puede ser anterior a la fecha de ingreso');
    }

    const res: any = await this.dataSource.query(
      `UPDATE planilla_trabajador
       SET fecha_cese = ?, cod_motivo_fin_periodo = ?, cod_situacion = '00',
           observaciones = CONCAT_WS(' | ', observaciones, ?), id_usuario_mod = ?
       WHERE id_trabajador = ? AND estado_registro = 'ACTIVO'`,
      [dto.fecha_cese, dto.cod_motivo_fin_periodo, dto.observacion?.trim() ?? null, userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Trabajador no encontrado');

    await this.auditoriaService.registrar('planilla_trabajador', id, 'ACTUALIZAR', userId, old, dto);
    return { id };
  }

  async remove(id: number, userId: number) {
    const old = await this.findOne(id);

    // Un trabajador con planillas ya calculadas no se borra: rompería el histórico.
    // Cuando exista planilla_planilla_detalle, esta verificación mira ahí. Por ahora
    // solo protege el historial de sueldos, que ya es motivo suficiente.
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM planilla_trabajador_remuneracion
       WHERE id_trabajador = ? AND estado_registro = 'ACTIVO' AND motivo <> 'INGRESO'`,
      [id],
    );
    if (Number(total) > 0) {
      throw new ConflictException(
        'Este trabajador ya tiene historial de sueldos: no se elimina, se cesa. Usa la acción "Cesar" para cerrar el vínculo laboral conservando el historial.',
      );
    }

    const res: any = await this.dataSource.query(
      `UPDATE planilla_trabajador SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
       WHERE id_trabajador = ? AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Trabajador no encontrado');

    await this.auditoriaService.registrar('planilla_trabajador', id, 'ELIMINAR', userId, old, null);
    return { id };
  }

  // ==========================================================================
  // Remuneraciones
  // ==========================================================================
  async findRemuneraciones(idTrabajador: number) {
    await this.findOne(idTrabajador);
    return this.dataSource.query(
      `SELECT id_remuneracion, vigencia_desde, sueldo_basico, moneda, motivo, observacion
       FROM planilla_trabajador_remuneracion
       WHERE id_trabajador = ? AND estado_registro = 'ACTIVO'
       ORDER BY vigencia_desde DESC`,
      [idTrabajador],
    );
  }

  async createRemuneracion(idTrabajador: number, dto: CreateRemuneracionDto, userId: number) {
    const trabajador = await this.findOne(idTrabajador);

    if (new Date(dto.vigencia_desde) < new Date(trabajador.fecha_ingreso)) {
      throw new BadRequestException('El sueldo no puede empezar a regir antes de la fecha de ingreso del trabajador');
    }

    try {
      const res: any = await this.dataSource.query(
        `INSERT INTO planilla_trabajador_remuneracion
          (id_trabajador, vigencia_desde, sueldo_basico, moneda, motivo, observacion, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`,
        [
          idTrabajador, dto.vigencia_desde, dto.sueldo_basico,
          dto.moneda ?? 'PEN', dto.motivo ?? 'AUMENTO',
          dto.observacion?.trim() ?? null, userId,
        ],
      );
      const idNuevo = Number(res.insertId);
      await this.auditoriaService.registrar('planilla_trabajador_remuneracion', idNuevo, 'CREAR', userId, null, dto);
      return { id: idNuevo };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya hay un sueldo registrado con esa misma fecha de vigencia');
      }
      throw error;
    }
  }

  async removeRemuneracion(idTrabajador: number, idRemuneracion: number, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_trabajador_remuneracion
       WHERE id_remuneracion = ? AND id_trabajador = ? AND estado_registro = 'ACTIVO'`,
      [idRemuneracion, idTrabajador],
    );
    if (!old) throw new NotFoundException('Registro de sueldo no encontrado');

    // El sueldo de ingreso es el piso del historial: sin él, el trabajador se queda
    // sin ningún sueldo vigente y el motor no puede calcular nada.
    if (old.motivo === 'INGRESO') {
      throw new BadRequestException(
        'El sueldo de ingreso no se elimina: es el punto de partida del historial. Si el monto está mal, corrígelo registrando un ajuste.',
      );
    }

    const res: any = await this.dataSource.query(
      `UPDATE planilla_trabajador_remuneracion SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
       WHERE id_remuneracion = ? AND estado_registro = 'ACTIVO'`,
      [userId, idRemuneracion],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Registro de sueldo no encontrado');

    await this.auditoriaService.registrar('planilla_trabajador_remuneracion', idRemuneracion, 'ELIMINAR', userId, old, null);
    return { id: idRemuneracion };
  }

  // ==========================================================================
  // Conceptos fijos
  // ==========================================================================
  async findConceptosFijos(idTrabajador: number) {
    await this.findOne(idTrabajador);
    return this.dataSource.query(
      `SELECT cf.id_concepto_fijo, cf.id_concepto, c.codigo_plame, c.nombre AS nombre_concepto, c.tipo,
              cf.monto, cf.porcentaje, cf.vigencia_desde, cf.vigencia_hasta,
              cf.numero_cuotas, cf.cuotas_pagadas, cf.saldo_pendiente, cf.observacion
       FROM planilla_trabajador_concepto_fijo cf
       JOIN planilla_concepto c ON c.id_concepto = cf.id_concepto
       WHERE cf.id_trabajador = ? AND cf.estado_registro = 'ACTIVO'
       ORDER BY cf.vigencia_desde DESC`,
      [idTrabajador],
    );
  }

  private validarConceptoFijo(dto: CreateConceptoFijoDto | UpdateConceptoFijoDto) {
    const tieneMonto = dto.monto !== undefined && dto.monto !== null;
    const tienePct = dto.porcentaje !== undefined && dto.porcentaje !== null;
    if (tieneMonto && tienePct) {
      throw new BadRequestException('Indica un monto fijo O un porcentaje del básico, no ambos');
    }
    if (!tieneMonto && !tienePct) {
      throw new BadRequestException('Indica un monto fijo o un porcentaje del básico');
    }
  }

  async createConceptoFijo(idTrabajador: number, dto: CreateConceptoFijoDto, userId: number) {
    await this.findOne(idTrabajador);
    this.validarConceptoFijo(dto);

    const [concepto] = await this.dataSource.query(
      `SELECT id_concepto FROM planilla_concepto WHERE id_concepto = ? AND estado_registro = 'ACTIVO'`,
      [dto.id_concepto],
    );
    if (!concepto) throw new BadRequestException('El concepto indicado no existe');

    const res: any = await this.dataSource.query(
      `INSERT INTO planilla_trabajador_concepto_fijo
        (id_trabajador, id_concepto, monto, porcentaje, vigencia_desde, vigencia_hasta,
         numero_cuotas, cuotas_pagadas, saldo_pendiente, observacion, estado_registro, id_usuario_crea)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'ACTIVO', ?)`,
      [
        idTrabajador, dto.id_concepto, dto.monto ?? null, dto.porcentaje ?? null,
        dto.vigencia_desde, dto.vigencia_hasta ?? null,
        dto.numero_cuotas ?? null, dto.saldo_pendiente ?? null,
        dto.observacion?.trim() ?? null, userId,
      ],
    );
    const idNuevo = Number(res.insertId);
    await this.auditoriaService.registrar('planilla_trabajador_concepto_fijo', idNuevo, 'CREAR', userId, null, dto);
    return { id: idNuevo };
  }

  async removeConceptoFijo(idTrabajador: number, idConceptoFijo: number, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_trabajador_concepto_fijo
       WHERE id_concepto_fijo = ? AND id_trabajador = ? AND estado_registro = 'ACTIVO'`,
      [idConceptoFijo, idTrabajador],
    );
    if (!old) throw new NotFoundException('Concepto fijo no encontrado');

    const res: any = await this.dataSource.query(
      `UPDATE planilla_trabajador_concepto_fijo SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
       WHERE id_concepto_fijo = ? AND estado_registro = 'ACTIVO'`,
      [userId, idConceptoFijo],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Concepto fijo no encontrado');

    await this.auditoriaService.registrar('planilla_trabajador_concepto_fijo', idConceptoFijo, 'ELIMINAR', userId, old, null);
    return { id: idConceptoFijo };
  }

  // ==========================================================================
  // Configuración laboral de la empresa
  // ==========================================================================
  async findEmpresaConfig(idEmpresa: number) {
    const [row] = await this.dataSource.query(
      `SELECT c.*, e.razon_social, e.ruc, e.regimen_tributario,
              r.codigo AS codigo_regimen_default, r.nombre AS nombre_regimen_default
       FROM planilla_empresa_config c
       JOIN empresa e ON e.id_empresa = c.id_empresa
       LEFT JOIN planilla_regimen_laboral r ON r.id_regimen = c.id_regimen_default
       WHERE c.id_empresa = ? AND c.estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!row) throw new NotFoundException('Esta empresa no tiene configuración de planilla');
    return row;
  }

  /** Empresas con su config, para el selector y para ver cuáles faltan revisar. */
  findEmpresasConConfig() {
    return this.dataSource.query(
      `SELECT e.id_empresa, e.razon_social, e.ruc, e.regimen_tributario,
              c.id_config, c.id_regimen_default, r.codigo AS codigo_regimen_default,
              c.afecto_sctr, c.afecto_senati, c.horas_jornada, c.dias_mes,
              (SELECT COUNT(*) FROM planilla_trabajador t
               WHERE t.id_empresa = e.id_empresa AND t.estado_registro = 'ACTIVO'
                 AND t.cod_situacion <> '00' AND t.fecha_cese IS NULL) AS trabajadores_activos
       FROM empresa e
       LEFT JOIN planilla_empresa_config c ON c.id_empresa = e.id_empresa AND c.estado_registro = 'ACTIVO'
       LEFT JOIN planilla_regimen_laboral r ON r.id_regimen = c.id_regimen_default
       WHERE e.estado_registro = 'ACTIVO' AND e.estado_cliente = 'ACTIVO'
       ORDER BY e.razon_social`,
    );
  }

  async updateEmpresaConfig(idEmpresa: number, dto: UpdateEmpresaConfigDto, userId: number) {
    const old = await this.findEmpresaConfig(idEmpresa);

    const res: any = await this.dataSource.query(
      `UPDATE planilla_empresa_config SET
        id_regimen_default = ?, cod_regimen_salud = ?, pct_credito_eps = ?,
        afecto_senati = ?, pct_senati = ?, afecto_sctr = ?, tasa_sctr_salud = ?, tasa_sctr_pension = ?,
        horas_jornada = ?, dias_mes = ?, pct_adelanto_quincena = ?,
        id_banco_haberes = ?, cuenta_cargo_telecredito = ?, codigo_establecimiento_sunat = ?,
        id_usuario_mod = ?
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [
        dto.id_regimen_default === undefined ? old.id_regimen_default : dto.id_regimen_default ?? null,
        val(dto.cod_regimen_salud, old.cod_regimen_salud),
        val(dto.pct_credito_eps, old.pct_credito_eps),
        bit(dto.afecto_senati, old.afecto_senati),
        val(dto.pct_senati, old.pct_senati),
        bit(dto.afecto_sctr, old.afecto_sctr),
        val(dto.tasa_sctr_salud, old.tasa_sctr_salud),
        val(dto.tasa_sctr_pension, old.tasa_sctr_pension),
        val(dto.horas_jornada, old.horas_jornada),
        val(dto.dias_mes, old.dias_mes),
        val(dto.pct_adelanto_quincena, old.pct_adelanto_quincena),
        dto.id_banco_haberes === undefined ? old.id_banco_haberes : dto.id_banco_haberes ?? null,
        dto.cuenta_cargo_telecredito === undefined ? old.cuenta_cargo_telecredito : dto.cuenta_cargo_telecredito?.trim() ?? null,
        dto.codigo_establecimiento_sunat === undefined ? old.codigo_establecimiento_sunat : dto.codigo_establecimiento_sunat?.trim() ?? null,
        userId, idEmpresa,
      ],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Configuración no encontrada');

    await this.auditoriaService.registrar('planilla_empresa_config', old.id_config, 'ACTUALIZAR', userId, old, dto);
    return { id: old.id_config };
  }

  /**
   * Abre SUNAT SOL ya logueado con la Clave SOL de la empresa, en un Chromium visible,
   * para que el usuario entre al T-Registro y consulte el padrón.
   *
   * No scrapea el padrón automáticamente a propósito — ver sunat-tregistro.client.ts
   * para el razonamiento: los selectores internos no están verificados y el WAF de
   * SUNAT bloquea tras ~8 sesiones seguidas.
   */
  async abrirTregistro(idEmpresa: number, userId: number) {
    const [row] = await this.dataSource.query(
      `SELECT ruc, razon_social, sunat_sol_usuario, sunat_sol_password
       FROM empresa WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!row) throw new NotFoundException('Empresa no encontrada');
    if (!row.sunat_sol_usuario || !row.sunat_sol_password) {
      throw new ConflictException(
        'Esta empresa no tiene Usuario/Clave SOL guardados. Cárgalos en Catálogo → Empresas antes de abrir el T-Registro.',
      );
    }

    const solUsuario = this.credencialesCrypto.descifrar(row.sunat_sol_usuario);
    const solPassword = this.credencialesCrypto.descifrar(row.sunat_sol_password);

    // Se audita ANTES de abrir: si el navegador falla, igual queda registro de que
    // alguien pidió usar la Clave SOL de este cliente.
    await this.auditoriaService.registrar('empresa', idEmpresa, 'ACTUALIZAR', userId, null, {
      accion: 'abrir_tregistro_sunat',
    });

    await this.sunatTregistroClient.abrirSesionTregistro(row.ruc, solUsuario, solPassword);
    return {
      success: true,
      message: `Sesión abierta en SUNAT para ${row.razon_social}. Entra a T-Registro desde el menú.`,
    };
  }

  /**
   * Consulta el padrón del T-Registro y lo devuelve para que un humano lo confirme.
   *
   * NO crea trabajadores. La navegación interna del T-Registro todavía no está
   * verificada (ver el cliente de scraping y la guía TREG): si un selector agarra la
   * columna equivocada, es preferible que el usuario lo vea en la vista previa a
   * descubrirlo con 40 trabajadores mal cargados.
   *
   * `supervisado = true` abre el navegador visible, que es como hay que correrlo
   * mientras los selectores sigan sin confirmar.
   */
  async consultarTregistro(idEmpresa: number, supervisado: boolean, userId: number) {
    const [row] = await this.dataSource.query(
      `SELECT ruc, razon_social, sunat_sol_usuario, sunat_sol_password
       FROM empresa WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!row) throw new NotFoundException('Empresa no encontrada');
    if (!row.sunat_sol_usuario || !row.sunat_sol_password) {
      throw new ConflictException('Esta empresa no tiene Usuario/Clave SOL guardados');
    }

    const solUsuario = this.credencialesCrypto.descifrar(row.sunat_sol_usuario);
    const solPassword = this.credencialesCrypto.descifrar(row.sunat_sol_password);

    await this.auditoriaService.registrar('empresa', idEmpresa, 'ACTUALIZAR', userId, null, {
      accion: 'consultar_tregistro_sunat',
    });

    const resultado = await this.scrapingTregistro.extraerPadron(
      row.ruc, solUsuario, solPassword, !supervisado,
    );

    // Se traduce lo que devolvió el portal usando el catálogo de errores conocidos.
    // El 27/08/2026 se perdió más de una hora con tres errores que se veían iguales y
    // tenían causas distintas — uno de SUNAT, uno del navegador del usuario y uno
    // nuestro. Cada diagnóstico equivocado costó un login, y el WAF tolera ~8.
    await this.anotarErroresConocidos(resultado.diagnostico);

    // Se marcan los que ya existen para no ofrecer duplicados: el UNIQUE los
    // rechazaría igual, pero avisarlo antes evita que el usuario crea que falló algo.
    const documentos = resultado.trabajadores.map((t) => t.numero_documento).filter(Boolean);
    let existentes: string[] = [];
    if (documentos.length) {
      const filas = await this.dataSource.query(
        `SELECT numero_documento FROM planilla_trabajador
         WHERE id_empresa = ? AND estado_registro = 'ACTIVO' AND numero_documento IN (?)`,
        [idEmpresa, documentos],
      );
      existentes = filas.map((f: any) => f.numero_documento);
    }

    return {
      ...resultado,
      empresa: row.razon_social,
      ruc: row.ruc,
      trabajadores: resultado.trabajadores.map((t) => ({
        ...t,
        ya_existe: existentes.includes(t.numero_documento),
      })),
      nuevos: resultado.trabajadores.filter((t) => !existentes.includes(t.numero_documento)).length,
    };
  }

  // ==========================================================================
  // Validaciones compartidas
  // ==========================================================================
  private async validarRegimenYEmpresa(idEmpresa: number, idRegimen: number) {
    const [empresa] = await this.dataSource.query(
      `SELECT id_empresa FROM empresa WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!empresa) throw new BadRequestException('La empresa indicada no existe');

    const [regimen] = await this.dataSource.query(
      `SELECT id_regimen FROM planilla_regimen_laboral WHERE id_regimen = ? AND estado_registro = 'ACTIVO'`,
      [idRegimen],
    );
    if (!regimen) throw new BadRequestException('El régimen laboral indicado no existe');
  }

  private validarFechas(fechaIngreso: any, fechaCese: any) {
    if (fechaCese && new Date(fechaCese) < new Date(fechaIngreso)) {
      throw new BadRequestException('La fecha de cese no puede ser anterior a la fecha de ingreso');
    }
  }

  /**
   * Un afiliado a AFP sin AFP asignada rompe el cálculo del descuento previsional:
   * el motor no sabría qué comisión aplicar y lo saltaría en silencio.
   */
  private validarAfp(regimenPensionario: any, idAfp: any, tipoComision: any) {
    if (regimenPensionario !== 'AFP') return;
    if (!idAfp) {
      throw new BadRequestException('Un trabajador afiliado al SPP necesita tener una AFP asignada');
    }
    if (!tipoComision) {
      throw new BadRequestException('Indica si la comisión de la AFP es por flujo o mixta: cambia cuánto se le descuenta');
    }
  }

  /**
   * Busca en el diagnóstico los errores del catálogo y agrega la causa real.
   *
   * Convierte "SUNAT dijo algo raro" en "esto es de SUNAT, esperá" o "esto es
   * nuestro, tocá tal archivo". Sin esto, el 27/08/2026 tres errores que se veían
   * iguales mandaron a corregir código que estaba bien, dos veces.
   *
   * No corta nunca el flujo: si el catálogo falla, el diagnóstico crudo sigue estando.
   */
  private async anotarErroresConocidos(diagnostico: string[]): Promise<void> {
    if (!diagnostico?.length) return;

    try {
      const catalogo = await this.dataSource.query(
        `SELECT id_error, codigo, patron, titulo, origen, causa, que_hacer, reintentar_sirve
           FROM sunat_error_conocido
          WHERE estado_registro = 'ACTIVO'`,
      );
      if (!catalogo.length) return;

      // Se compara sin tildes: el portal las escribe de forma inconsistente y por eso
      // los patrones del catálogo también están guardados sin ellas.
      const sinTildes = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const texto = sinTildes(diagnostico.join(' \n '));

      const vistos: number[] = [];

      for (const e of catalogo) {
        let coincide = false;
        try {
          coincide = new RegExp(sinTildes(e.patron), 'i').test(texto);
        } catch {
          // Un patrón mal escrito no debe romper la consulta entera.
          continue;
        }
        if (!coincide) continue;

        vistos.push(e.id_error);
        diagnostico.push(
          `━━ ERROR CONOCIDO [${e.codigo}] · es de: ${e.origen} ━━ ` +
          `${e.titulo}. CAUSA: ${e.causa} QUÉ HACER: ${e.que_hacer} ` +
          (e.reintentar_sirve ? '(reintentar puede servir)' : '(reintentar NO sirve y gasta intentos contra el WAF)'),
        );
      }

      // El contador dice qué falla de verdad seguido, para saber qué vale la pena
      // arreglar en serio y qué fue una anécdota de un día.
      if (vistos.length) {
        await this.dataSource.query(
          `UPDATE sunat_error_conocido
              SET veces_visto = veces_visto + 1, ultima_vez = NOW()
            WHERE id_error IN (?)`,
          [vistos],
        );
      }
    } catch (e: any) {
      diagnostico.push(`(No se pudo consultar el catálogo de errores: ${e?.message ?? e})`);
    }
  }

}

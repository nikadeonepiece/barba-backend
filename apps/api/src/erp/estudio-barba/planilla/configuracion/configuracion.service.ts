import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditoriaService } from '@app/common';
import {
  UpdateRegimenDto, CreateAfpTasaDto, UpdateAfpTasaDto,
  CreateParametroDto, UpdateParametroDto, UpdateEscalaDto,
  UpdateBancoDto, CreateTareoMarcaDto, UpdateTareoMarcaDto,
} from './dto/configuracion.dto';

const bit = (v: any, actual: number): number => (v === undefined || v === null ? actual : v ? 1 : 0);
const val = <T>(v: T | undefined | null, actual: T): T => (v === undefined || v === null ? actual : v);

@Injectable()
export class ConfiguracionService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
  ) {}

  // ==========================================================================
  // Resumen — alimenta el aviso de la pantalla
  // ==========================================================================
  /**
   * Cuenta cuántos valores están sin verificar contra su fuente oficial.
   *
   * Existe porque una tasa AFP equivocada descuenta mal a TODOS los trabajadores
   * de TODAS las empresas, y el error recién se ve en la boleta. La pantalla usa
   * esto para advertir antes de que alguien calcule en serio.
   */
  async resumen() {
    const [[params], [tasas]] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*) AS total, SUM(verificado = 0) AS sin_verificar
         FROM planilla_parametro_laboral WHERE estado_registro = 'ACTIVO'`,
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total, SUM(verificado = 0) AS sin_verificar
         FROM planilla_afp_tasa WHERE estado_registro = 'ACTIVO'`,
      ),
    ]);

    const sinVerificar = Number(params.sin_verificar || 0) + Number(tasas.sin_verificar || 0);
    return {
      parametros_total: Number(params.total || 0),
      parametros_sin_verificar: Number(params.sin_verificar || 0),
      tasas_afp_total: Number(tasas.total || 0),
      tasas_afp_sin_verificar: Number(tasas.sin_verificar || 0),
      sin_verificar_total: sinVerificar,
      listo_para_calcular: sinVerificar === 0,
    };
  }

  // ==========================================================================
  // Regímenes laborales
  // ==========================================================================
  findRegimenes() {
    return this.dataSource.query(
      `SELECT id_regimen, codigo, nombre, cod_regimen_laboral_sunat, vigencia_desde,
              dias_vacaciones, factor_gratificacion, factor_cts,
              aplica_asignacion_familiar, aplica_essalud, pension_obligatoria,
              dias_indemnizacion_por_anio, tope_dias_indemnizacion, base_legal
       FROM planilla_regimen_laboral
       WHERE estado_registro = 'ACTIVO'
       ORDER BY id_regimen`,
    );
  }

  async updateRegimen(id: number, dto: UpdateRegimenDto, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_regimen_laboral WHERE id_regimen = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!old) throw new NotFoundException('Régimen no encontrado');

    const res: any = await this.dataSource.query(
      `UPDATE planilla_regimen_laboral
       SET nombre = ?, dias_vacaciones = ?, factor_gratificacion = ?, factor_cts = ?,
           aplica_asignacion_familiar = ?, aplica_essalud = ?, pension_obligatoria = ?,
           dias_indemnizacion_por_anio = ?, tope_dias_indemnizacion = ?, base_legal = ?,
           id_usuario_mod = ?
       WHERE id_regimen = ? AND estado_registro = 'ACTIVO'`,
      [
        val(dto.nombre?.trim(), old.nombre),
        val(dto.dias_vacaciones, old.dias_vacaciones),
        val(dto.factor_gratificacion, old.factor_gratificacion),
        val(dto.factor_cts, old.factor_cts),
        bit(dto.aplica_asignacion_familiar, old.aplica_asignacion_familiar),
        bit(dto.aplica_essalud, old.aplica_essalud),
        bit(dto.pension_obligatoria, old.pension_obligatoria),
        val(dto.dias_indemnizacion_por_anio, old.dias_indemnizacion_por_anio),
        val(dto.tope_dias_indemnizacion, old.tope_dias_indemnizacion),
        val(dto.base_legal?.trim(), old.base_legal),
        userId,
        id,
      ],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Régimen no encontrado');

    await this.auditoriaService.registrar('planilla_regimen_laboral', id, 'ACTUALIZAR', userId, old, dto);
    return { id };
  }

  // ==========================================================================
  // AFP y sus tasas
  // ==========================================================================
  findAfps() {
    return this.dataSource.query(
      `SELECT id_afp, codigo, nombre FROM planilla_afp WHERE estado_registro = 'ACTIVO' ORDER BY nombre`,
    );
  }

  findAfpTasas() {
    return this.dataSource.query(
      `SELECT t.id_afp_tasa, t.id_afp, a.nombre AS nombre_afp, a.codigo AS codigo_afp,
              t.vigencia_desde, t.vigencia_hasta,
              t.pct_aporte_obligatorio, t.pct_comision_flujo, t.pct_comision_mixta_flujo,
              t.pct_comision_mixta_saldo, t.pct_prima_seguro, t.tope_remuneracion_asegurable,
              t.verificado, t.fuente
       FROM planilla_afp_tasa t
       JOIN planilla_afp a ON a.id_afp = t.id_afp AND a.estado_registro = 'ACTIVO'
       WHERE t.estado_registro = 'ACTIVO'
       ORDER BY a.nombre, t.vigencia_desde DESC`,
    );
  }

  async createAfpTasa(dto: CreateAfpTasaDto, userId: number) {
    const [afp] = await this.dataSource.query(
      `SELECT id_afp FROM planilla_afp WHERE id_afp = ? AND estado_registro = 'ACTIVO'`,
      [dto.id_afp],
    );
    if (!afp) throw new BadRequestException('La AFP indicada no existe');

    if (dto.vigencia_hasta && dto.vigencia_hasta < dto.vigencia_desde) {
      throw new BadRequestException('La vigencia "hasta" no puede ser anterior a la vigencia "desde"');
    }

    try {
      const res: any = await this.dataSource.query(
        `INSERT INTO planilla_afp_tasa
          (id_afp, vigencia_desde, vigencia_hasta, pct_aporte_obligatorio,
           pct_comision_flujo, pct_comision_mixta_flujo, pct_comision_mixta_saldo,
           pct_prima_seguro, tope_remuneracion_asegurable, verificado, fuente,
           estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`,
        [
          dto.id_afp, dto.vigencia_desde, dto.vigencia_hasta ?? null,
          dto.pct_aporte_obligatorio ?? 10, dto.pct_comision_flujo ?? 0,
          dto.pct_comision_mixta_flujo ?? 0, dto.pct_comision_mixta_saldo ?? 0,
          dto.pct_prima_seguro ?? 0, dto.tope_remuneracion_asegurable ?? null,
          dto.verificado ? 1 : 0, dto.fuente?.trim() ?? null, userId,
        ],
      );
      const idNuevo = Number(res.insertId);
      await this.auditoriaService.registrar('planilla_afp_tasa', idNuevo, 'CREAR', userId, null, dto);
      return { id: idNuevo };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe una tasa para esa AFP con la misma fecha de vigencia');
      }
      throw error;
    }
  }

  async updateAfpTasa(id: number, dto: UpdateAfpTasaDto, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_afp_tasa WHERE id_afp_tasa = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!old) throw new NotFoundException('Tasa no encontrada');

    const desde = val(dto.vigencia_desde, old.vigencia_desde);
    const hasta = dto.vigencia_hasta === undefined ? old.vigencia_hasta : dto.vigencia_hasta;
    if (hasta && new Date(hasta) < new Date(desde)) {
      throw new BadRequestException('La vigencia "hasta" no puede ser anterior a la vigencia "desde"');
    }

    try {
      const res: any = await this.dataSource.query(
        `UPDATE planilla_afp_tasa
         SET vigencia_desde = ?, vigencia_hasta = ?, pct_aporte_obligatorio = ?,
             pct_comision_flujo = ?, pct_comision_mixta_flujo = ?, pct_comision_mixta_saldo = ?,
             pct_prima_seguro = ?, tope_remuneracion_asegurable = ?, verificado = ?, fuente = ?,
             id_usuario_mod = ?
         WHERE id_afp_tasa = ? AND estado_registro = 'ACTIVO'`,
        [
          desde, hasta ?? null,
          val(dto.pct_aporte_obligatorio, old.pct_aporte_obligatorio),
          val(dto.pct_comision_flujo, old.pct_comision_flujo),
          val(dto.pct_comision_mixta_flujo, old.pct_comision_mixta_flujo),
          val(dto.pct_comision_mixta_saldo, old.pct_comision_mixta_saldo),
          val(dto.pct_prima_seguro, old.pct_prima_seguro),
          dto.tope_remuneracion_asegurable === undefined ? old.tope_remuneracion_asegurable : dto.tope_remuneracion_asegurable,
          bit(dto.verificado, old.verificado),
          val(dto.fuente?.trim(), old.fuente),
          userId, id,
        ],
      );
      if (res.affectedRows === 0) throw new NotFoundException('Tasa no encontrada');

      await this.auditoriaService.registrar('planilla_afp_tasa', id, 'ACTUALIZAR', userId, old, dto);
      return { id };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe una tasa para esa AFP con la misma fecha de vigencia');
      }
      throw error;
    }
  }

  async removeAfpTasa(id: number, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_afp_tasa WHERE id_afp_tasa = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!old) throw new NotFoundException('Tasa no encontrada');

    const res: any = await this.dataSource.query(
      `UPDATE planilla_afp_tasa SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
       WHERE id_afp_tasa = ? AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Tasa no encontrada');

    await this.auditoriaService.registrar('planilla_afp_tasa', id, 'ELIMINAR', userId, old, null);
    return { id };
  }

  // ==========================================================================
  // Parámetros laborales
  // ==========================================================================
  findParametros() {
    return this.dataSource.query(
      `SELECT id_parametro, codigo, nombre, valor, unidad, vigencia_desde, vigencia_hasta,
              base_legal, verificado, fuente
       FROM planilla_parametro_laboral
       WHERE estado_registro = 'ACTIVO'
       ORDER BY codigo, vigencia_desde DESC`,
    );
  }

  async createParametro(dto: CreateParametroDto, userId: number) {
    if (dto.vigencia_hasta && dto.vigencia_hasta < dto.vigencia_desde) {
      throw new BadRequestException('La vigencia "hasta" no puede ser anterior a la vigencia "desde"');
    }
    try {
      const res: any = await this.dataSource.query(
        `INSERT INTO planilla_parametro_laboral
          (codigo, nombre, valor, unidad, vigencia_desde, vigencia_hasta,
           base_legal, verificado, fuente, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`,
        [
          dto.codigo.trim().toUpperCase(), dto.nombre.trim(), dto.valor, dto.unidad,
          dto.vigencia_desde, dto.vigencia_hasta ?? null,
          dto.base_legal?.trim() ?? null, dto.verificado ? 1 : 0, dto.fuente?.trim() ?? null, userId,
        ],
      );
      const idNuevo = Number(res.insertId);
      await this.auditoriaService.registrar('planilla_parametro_laboral', idNuevo, 'CREAR', userId, null, dto);
      return { id: idNuevo };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe ese parámetro con la misma fecha de vigencia');
      }
      throw error;
    }
  }

  async updateParametro(id: number, dto: UpdateParametroDto, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_parametro_laboral WHERE id_parametro = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!old) throw new NotFoundException('Parámetro no encontrado');

    const desde = val(dto.vigencia_desde, old.vigencia_desde);
    const hasta = dto.vigencia_hasta === undefined ? old.vigencia_hasta : dto.vigencia_hasta;
    if (hasta && new Date(hasta) < new Date(desde)) {
      throw new BadRequestException('La vigencia "hasta" no puede ser anterior a la vigencia "desde"');
    }

    try {
      const res: any = await this.dataSource.query(
        `UPDATE planilla_parametro_laboral
         SET nombre = ?, valor = ?, unidad = ?, vigencia_desde = ?, vigencia_hasta = ?,
             base_legal = ?, verificado = ?, fuente = ?, id_usuario_mod = ?
         WHERE id_parametro = ? AND estado_registro = 'ACTIVO'`,
        [
          val(dto.nombre?.trim(), old.nombre),
          val(dto.valor, old.valor),
          val(dto.unidad, old.unidad),
          desde, hasta ?? null,
          val(dto.base_legal?.trim(), old.base_legal),
          bit(dto.verificado, old.verificado),
          val(dto.fuente?.trim(), old.fuente),
          userId, id,
        ],
      );
      if (res.affectedRows === 0) throw new NotFoundException('Parámetro no encontrado');

      await this.auditoriaService.registrar('planilla_parametro_laboral', id, 'ACTUALIZAR', userId, old, dto);
      return { id };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe ese parámetro con la misma fecha de vigencia');
      }
      throw error;
    }
  }

  async removeParametro(id: number, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_parametro_laboral WHERE id_parametro = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!old) throw new NotFoundException('Parámetro no encontrado');

    const res: any = await this.dataSource.query(
      `UPDATE planilla_parametro_laboral SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
       WHERE id_parametro = ? AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Parámetro no encontrado');

    await this.auditoriaService.registrar('planilla_parametro_laboral', id, 'ELIMINAR', userId, old, null);
    return { id };
  }

  // ==========================================================================
  // Escala de renta de quinta
  // ==========================================================================
  findEscala() {
    return this.dataSource.query(
      `SELECT id_escala, anio, tramo, uit_desde, uit_hasta, tasa, base_legal, verificado
       FROM planilla_escala_renta_quinta
       WHERE estado_registro = 'ACTIVO'
       ORDER BY anio DESC, tramo`,
    );
  }

  async updateEscala(id: number, dto: UpdateEscalaDto, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_escala_renta_quinta WHERE id_escala = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!old) throw new NotFoundException('Tramo no encontrado');

    const desde = val(dto.uit_desde, Number(old.uit_desde));
    const hasta = dto.uit_hasta === undefined ? (old.uit_hasta === null ? null : Number(old.uit_hasta)) : dto.uit_hasta;
    if (hasta !== null && hasta !== undefined && hasta <= desde) {
      throw new BadRequestException('El límite superior del tramo debe ser mayor que el inferior');
    }

    const res: any = await this.dataSource.query(
      `UPDATE planilla_escala_renta_quinta
       SET uit_desde = ?, uit_hasta = ?, tasa = ?, base_legal = ?, verificado = ?, id_usuario_mod = ?
       WHERE id_escala = ? AND estado_registro = 'ACTIVO'`,
      [
        desde, hasta ?? null,
        val(dto.tasa, old.tasa),
        val(dto.base_legal?.trim(), old.base_legal),
        bit(dto.verificado, old.verificado),
        userId, id,
      ],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Tramo no encontrado');

    await this.auditoriaService.registrar('planilla_escala_renta_quinta', id, 'ACTUALIZAR', userId, old, dto);
    return { id };
  }

  // ==========================================================================
  // Bancos
  // ==========================================================================
  findBancos() {
    return this.dataSource.query(
      `SELECT id_banco, codigo_sunat, nombre, formato_telecredito, longitud_cuenta, longitud_cci
       FROM planilla_banco
       WHERE estado_registro = 'ACTIVO'
       ORDER BY codigo_sunat`,
    );
  }

  async updateBanco(id: number, dto: UpdateBancoDto, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_banco WHERE id_banco = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!old) throw new NotFoundException('Banco no encontrado');

    const res: any = await this.dataSource.query(
      `UPDATE planilla_banco
       SET nombre = ?, formato_telecredito = ?, longitud_cuenta = ?, longitud_cci = ?, id_usuario_mod = ?
       WHERE id_banco = ? AND estado_registro = 'ACTIVO'`,
      [
        val(dto.nombre?.trim(), old.nombre),
        val(dto.formato_telecredito, old.formato_telecredito),
        dto.longitud_cuenta === undefined ? old.longitud_cuenta : dto.longitud_cuenta,
        val(dto.longitud_cci, old.longitud_cci),
        userId, id,
      ],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Banco no encontrado');

    await this.auditoriaService.registrar('planilla_banco', id, 'ACTUALIZAR', userId, old, dto);
    return { id };
  }

  // ==========================================================================
  // Marcas del tareo
  // ==========================================================================
  findTareoMarcas() {
    return this.dataSource.query(
      `SELECT id_marca, codigo, nombre, computa_dia_laborado, computa_falta, computa_feriado,
              computa_descanso, computa_subsidio, computa_vacaciones,
              computa_licencia_con_goce, computa_licencia_sin_goce,
              es_computable_beneficios, cod_tipo_suspension_sunat, color_hex, orden
       FROM planilla_tareo_marca
       WHERE estado_registro = 'ACTIVO'
       ORDER BY orden, codigo`,
    );
  }

  /** Tabla 21 de SUNAT — para vincular una marca con su tipo de suspensión declarable. */
  findTiposSuspension() {
    return this.catalogoSunat(21);
  }

  /**
   * Cualquier tabla paramétrica del Anexo 2, para alimentar desplegables.
   *
   * Un solo endpoint en vez de uno por tabla: son 30 catálogos de la misma forma
   * (código → descripción) y hacer 30 endpoints idénticos solo agrega superficie
   * que mantener. Se filtran los no vigentes y, por defecto, los que no aplican al
   * sector privado — que es lo único que lleva este estudio.
   */
  catalogoSunat(tablaNum: number, incluirSectorPublico = false) {
    const n = Number(tablaNum);
    if (!n || Number.isNaN(n)) throw new BadRequestException('Número de tabla inválido');

    const filtroSector = incluirSectorPublico ? '' : 'AND aplica_sector_privado = 1';
    return this.dataSource.query(
      `SELECT codigo, descripcion, descripcion_abreviada, tabla_nombre
       FROM planilla_sunat_catalogo
       WHERE tabla_num = ? AND vigente = 1 AND estado_registro = 'ACTIVO' ${filtroSector}
       ORDER BY codigo`,
      [n],
    );
  }

  private camposMarca(dto: CreateTareoMarcaDto | UpdateTareoMarcaDto, old?: any) {
    return [
      bit(dto.computa_dia_laborado, old?.computa_dia_laborado ?? 0),
      bit(dto.computa_falta, old?.computa_falta ?? 0),
      bit(dto.computa_feriado, old?.computa_feriado ?? 0),
      bit(dto.computa_descanso, old?.computa_descanso ?? 0),
      bit(dto.computa_subsidio, old?.computa_subsidio ?? 0),
      bit(dto.computa_vacaciones, old?.computa_vacaciones ?? 0),
      bit(dto.computa_licencia_con_goce, old?.computa_licencia_con_goce ?? 0),
      bit(dto.computa_licencia_sin_goce, old?.computa_licencia_sin_goce ?? 0),
      bit(dto.es_computable_beneficios, old?.es_computable_beneficios ?? 1),
      dto.cod_tipo_suspension_sunat?.trim() ?? old?.cod_tipo_suspension_sunat ?? null,
      dto.color_hex?.trim() ?? old?.color_hex ?? null,
      dto.orden ?? old?.orden ?? 0,
    ];
  }

  async createTareoMarca(dto: CreateTareoMarcaDto, userId: number) {
    try {
      const res: any = await this.dataSource.query(
        `INSERT INTO planilla_tareo_marca
          (codigo, nombre, computa_dia_laborado, computa_falta, computa_feriado,
           computa_descanso, computa_subsidio, computa_vacaciones,
           computa_licencia_con_goce, computa_licencia_sin_goce, es_computable_beneficios,
           cod_tipo_suspension_sunat, color_hex, orden, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`,
        [dto.codigo.trim().toUpperCase(), dto.nombre.trim(), ...this.camposMarca(dto), userId],
      );
      const idNuevo = Number(res.insertId);
      await this.auditoriaService.registrar('planilla_tareo_marca', idNuevo, 'CREAR', userId, null, dto);
      return { id: idNuevo };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') throw new ConflictException('Ya existe una marca con ese código');
      throw error;
    }
  }

  async updateTareoMarca(id: number, dto: UpdateTareoMarcaDto, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_tareo_marca WHERE id_marca = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!old) throw new NotFoundException('Marca no encontrada');

    try {
      const res: any = await this.dataSource.query(
        `UPDATE planilla_tareo_marca
         SET codigo = ?, nombre = ?, computa_dia_laborado = ?, computa_falta = ?, computa_feriado = ?,
             computa_descanso = ?, computa_subsidio = ?, computa_vacaciones = ?,
             computa_licencia_con_goce = ?, computa_licencia_sin_goce = ?, es_computable_beneficios = ?,
             cod_tipo_suspension_sunat = ?, color_hex = ?, orden = ?, id_usuario_mod = ?
         WHERE id_marca = ? AND estado_registro = 'ACTIVO'`,
        [
          val(dto.codigo?.trim().toUpperCase(), old.codigo),
          val(dto.nombre?.trim(), old.nombre),
          ...this.camposMarca(dto, old),
          userId, id,
        ],
      );
      if (res.affectedRows === 0) throw new NotFoundException('Marca no encontrada');

      await this.auditoriaService.registrar('planilla_tareo_marca', id, 'ACTUALIZAR', userId, old, dto);
      return { id };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') throw new ConflictException('Ya existe una marca con ese código');
      throw error;
    }
  }

  async removeTareoMarca(id: number, userId: number) {
    const [old] = await this.dataSource.query(
      `SELECT * FROM planilla_tareo_marca WHERE id_marca = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!old) throw new NotFoundException('Marca no encontrada');

    const res: any = await this.dataSource.query(
      `UPDATE planilla_tareo_marca SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
       WHERE id_marca = ? AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Marca no encontrada');

    await this.auditoriaService.registrar('planilla_tareo_marca', id, 'ELIMINAR', userId, old, null);
    return { id };
  }
}

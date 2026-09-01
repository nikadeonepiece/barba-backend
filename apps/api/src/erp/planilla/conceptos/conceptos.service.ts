import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditoriaService } from '@app/common';
import { CreateConceptoDto, UpdateConceptoDto, UpdateReglasConceptoDto } from './dto/concepto.dto';

const COLS_ORDER_ALLOWED = ['codigo_plame', 'nombre', 'tipo', 'grupo_sunat', 'orden_impresion'];

// Columnas que salen del archivo oficial de SUNAT. El estudio no las edita: la
// próxima reimportación las devolvería a su valor original y el cambio se perdería
// sin aviso. Se listan acá para que quede explícito de dónde viene cada dato.
const COLS_DE_SUNAT = [
  'nombre', 'grupo_sunat', 'tipo', 'solo_sector_publico', 'es_remunerativo',
  'afecto_renta_quinta', 'afecto_essalud', 'afecto_sctr', 'afecto_senati',
  'afecto_onp', 'afecto_afp', 'afecto_ies',
];

const bit = (v: any, actual: number): number => (v === undefined || v === null ? actual : v ? 1 : 0);

@Injectable()
export class ConceptosService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
  ) {}

  async findAll(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;

    const where: string[] = ["t.estado_registro = 'ACTIVO'"];
    const params: any[] = [];

    // Por defecto se ocultan los 117 conceptos del régimen laboral público: el
    // estudio lleva empresas privadas y verlos solo estorba. Se muestran si se pide.
    if (query.incluirSectorPublico !== 'true') {
      where.push('t.solo_sector_publico = 0');
    }

    if (query.search) {
      where.push('(t.codigo_plame LIKE ? OR t.nombre LIKE ?)');
      params.push(`%${query.search}%`, `%${query.search}%`);
    }
    if (query.tipo) {
      where.push('t.tipo = ?');
      params.push(query.tipo);
    }
    if (query.grupo) {
      where.push('t.grupo_sunat = ?');
      params.push(query.grupo);
    }
    if (query.soloPropios === 'true') {
      where.push('t.editable = 1');
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort) ? query.sort : 'codigo_plame';
    const sortDir = query.dir === 'DESC' ? 'DESC' : 'ASC';

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT t.id_concepto, t.codigo_plame, t.nombre, t.grupo_sunat, t.tipo,
                t.solo_sector_publico, t.es_remunerativo, t.afecto_renta_quinta,
                t.afecto_essalud, t.afecto_sctr, t.afecto_senati, t.afecto_onp,
                t.afecto_afp, t.afecto_ies,
                t.base_cts, t.base_gratificacion, t.base_vacaciones,
                t.tipo_calculo, t.formula, t.porcentaje_default,
                t.orden_impresion, t.editable
         FROM planilla_concepto t
         ${whereSql}
         ORDER BY t.${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total FROM planilla_concepto t ${whereSql}`, params),
    ]);

    return { data, meta: { total: Number(total), page, limit } };
  }

  // Alimenta el filtro por grupo del listado. Sale de la data real y no de una
  // constante en el código, para que un grupo nuevo de SUNAT aparezca solo.
  async gruposDisponibles() {
    return this.dataSource.query(
      `SELECT grupo_sunat, COUNT(*) AS total
       FROM planilla_concepto
       WHERE estado_registro = 'ACTIVO' AND grupo_sunat IS NOT NULL
       GROUP BY grupo_sunat
       ORDER BY MIN(codigo_plame)`,
    );
  }

  // Datos de la versión del archivo de SUNAT que está cargada, para mostrarlos en la
  // pantalla: sin esto nadie sabe si el catálogo está al día o es de hace dos años.
  async versionVigente() {
    const [row] = await this.dataSource.query(
      `SELECT id_descarga, nombre_archivo_sunat, url_origen, last_modified_http,
              fecha_importacion, conceptos_total, fecha_ultima_verificacion
       FROM planilla_sunat_descarga
       WHERE es_vigente = 1 AND estado_registro = 'ACTIVO'
       LIMIT 1`,
    );
    return row ?? null;
  }

  async findOne(id: number) {
    const [row] = await this.dataSource.query(
      `SELECT t.* FROM planilla_concepto t WHERE t.id_concepto = ? AND t.estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!row) throw new NotFoundException('Concepto no encontrado');
    return row;
  }

  async create(dto: CreateConceptoDto, userId: number) {
    try {
      const res: any = await this.dataSource.query(
        `INSERT INTO planilla_concepto
          (codigo_plame, nombre, grupo_sunat, tipo, solo_sector_publico,
           es_remunerativo, afecto_renta_quinta, afecto_essalud, afecto_sctr,
           afecto_senati, afecto_onp, afecto_afp, afecto_ies,
           base_cts, base_gratificacion, base_vacaciones,
           tipo_calculo, formula, porcentaje_default, orden_impresion,
           editable, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ACTIVO', ?)`,
        [
          dto.codigo_plame.trim(),
          dto.nombre.trim(),
          dto.grupo_sunat?.trim() ?? 'CONCEPTO PROPIO DEL ESTUDIO',
          dto.tipo,
          bit(dto.es_remunerativo, 0),
          bit(dto.afecto_renta_quinta, 0),
          bit(dto.afecto_essalud, 0),
          bit(dto.afecto_sctr, 0),
          bit(dto.afecto_senati, 0),
          bit(dto.afecto_onp, 0),
          bit(dto.afecto_afp, 0),
          bit(dto.afecto_ies, 0),
          bit(dto.base_cts, 0),
          bit(dto.base_gratificacion, 0),
          bit(dto.base_vacaciones, 0),
          dto.tipo_calculo ?? 'MANUAL',
          dto.formula?.trim() ?? null,
          dto.porcentaje_default ?? null,
          dto.orden_impresion ?? 0,
          userId,
        ],
      );
      const idNuevo = Number(res.insertId);
      await this.auditoriaService.registrar('planilla_concepto', idNuevo, 'CREAR', userId, null, dto);
      return { id: idNuevo };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe un concepto con ese código PLAME');
      }
      throw error;
    }
  }

  /**
   * Edita las reglas del ESTUDIO sobre cualquier concepto (propio u oficial):
   * bases de CTS/gratificación/vacaciones, fórmula y orden en la boleta.
   *
   * Nunca toca los campos de SUNAT — ver COLS_DE_SUNAT.
   */
  async updateReglas(id: number, dto: UpdateReglasConceptoDto, userId: number) {
    const oldValues = await this.findOne(id);

    const res: any = await this.dataSource.query(
      `UPDATE planilla_concepto
       SET base_cts = ?, base_gratificacion = ?, base_vacaciones = ?,
           tipo_calculo = ?, formula = ?, porcentaje_default = ?, orden_impresion = ?,
           id_usuario_mod = ?
       WHERE id_concepto = ? AND estado_registro = 'ACTIVO'`,
      [
        bit(dto.base_cts, oldValues.base_cts),
        bit(dto.base_gratificacion, oldValues.base_gratificacion),
        bit(dto.base_vacaciones, oldValues.base_vacaciones),
        dto.tipo_calculo ?? oldValues.tipo_calculo,
        dto.formula?.trim() ?? oldValues.formula,
        dto.porcentaje_default ?? oldValues.porcentaje_default,
        dto.orden_impresion ?? oldValues.orden_impresion,
        userId,
        id,
      ],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Concepto no encontrado');

    await this.auditoriaService.registrar('planilla_concepto', id, 'ACTUALIZAR', userId, oldValues, dto);
    return { id };
  }

  /**
   * Edición completa — SOLO para conceptos propios del estudio (editable = 1).
   *
   * En un concepto de SUNAT esto se rechaza en vez de guardar a medias: si dejáramos
   * pasar el cambio de nombre o de afectaciones, la siguiente reimportación lo
   * revertiría y el usuario nunca sabría por qué "se deshizo" su edición.
   */
  async update(id: number, dto: UpdateConceptoDto, userId: number) {
    const oldValues = await this.findOne(id);

    if (!oldValues.editable) {
      throw new BadRequestException(
        'Este concepto viene de la Tabla 22 de SUNAT: su nombre, tipo y afectaciones no se editan porque la próxima ' +
          'reimportación los revertiría. Solo se pueden cambiar las reglas del estudio (bases de CTS, gratificación y vacaciones).',
      );
    }

    try {
      const res: any = await this.dataSource.query(
        `UPDATE planilla_concepto
         SET codigo_plame = ?, nombre = ?, grupo_sunat = ?, tipo = ?,
             es_remunerativo = ?, afecto_renta_quinta = ?, afecto_essalud = ?, afecto_sctr = ?,
             afecto_senati = ?, afecto_onp = ?, afecto_afp = ?, afecto_ies = ?,
             base_cts = ?, base_gratificacion = ?, base_vacaciones = ?,
             tipo_calculo = ?, formula = ?, porcentaje_default = ?, orden_impresion = ?,
             id_usuario_mod = ?
         WHERE id_concepto = ? AND editable = 1 AND estado_registro = 'ACTIVO'`,
        [
          dto.codigo_plame?.trim() ?? oldValues.codigo_plame,
          dto.nombre?.trim() ?? oldValues.nombre,
          dto.grupo_sunat?.trim() ?? oldValues.grupo_sunat,
          dto.tipo ?? oldValues.tipo,
          bit(dto.es_remunerativo, oldValues.es_remunerativo),
          bit(dto.afecto_renta_quinta, oldValues.afecto_renta_quinta),
          bit(dto.afecto_essalud, oldValues.afecto_essalud),
          bit(dto.afecto_sctr, oldValues.afecto_sctr),
          bit(dto.afecto_senati, oldValues.afecto_senati),
          bit(dto.afecto_onp, oldValues.afecto_onp),
          bit(dto.afecto_afp, oldValues.afecto_afp),
          bit(dto.afecto_ies, oldValues.afecto_ies),
          bit(dto.base_cts, oldValues.base_cts),
          bit(dto.base_gratificacion, oldValues.base_gratificacion),
          bit(dto.base_vacaciones, oldValues.base_vacaciones),
          dto.tipo_calculo ?? oldValues.tipo_calculo,
          dto.formula?.trim() ?? oldValues.formula,
          dto.porcentaje_default ?? oldValues.porcentaje_default,
          dto.orden_impresion ?? oldValues.orden_impresion,
          userId,
          id,
        ],
      );
      if (res.affectedRows === 0) throw new NotFoundException('Concepto no encontrado');

      await this.auditoriaService.registrar('planilla_concepto', id, 'ACTUALIZAR', userId, oldValues, dto);
      return { id };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe un concepto con ese código PLAME');
      }
      throw error;
    }
  }

  /**
   * Baja lógica — SOLO de conceptos propios.
   *
   * Un concepto de SUNAT no se da de baja: existe porque SUNAT lo declara, y la
   * reimportación lo traería de vuelta igual. Para dejar de usarlo, simplemente no
   * se le asigna a ningún trabajador.
   */
  async remove(id: number, userId: number) {
    const oldValues = await this.findOne(id);

    if (!oldValues.editable) {
      throw new BadRequestException(
        'Este concepto viene de la Tabla 22 de SUNAT y no se puede eliminar: la próxima reimportación lo volvería a cargar. ' +
          'Para dejar de usarlo, basta con no asignarlo a ningún trabajador.',
      );
    }

    const res: any = await this.dataSource.query(
      `UPDATE planilla_concepto SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
       WHERE id_concepto = ? AND editable = 1 AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Concepto no encontrado');

    await this.auditoriaService.registrar('planilla_concepto', id, 'ELIMINAR', userId, oldValues, null);
    return { id };
  }
}

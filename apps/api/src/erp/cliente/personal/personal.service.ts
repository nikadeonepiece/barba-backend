import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { ContratosArchivoService } from '../../planilla/contratos/contratos-archivo.service';
import { resolverEmpresaDelUsuario } from '../scope-empresa';

const COLS_ORDER_ALLOWED = ['apellido_paterno', 'fecha_ingreso', 'cargo', 'area'];

/**
 * Personal — lado CLIENTE (solo lectura).
 *
 * Cada método recibe el `user` del token y arranca por `resolverEmpresaDelUsuario()`:
 * el `id_empresa` que sale de ahí entra en el `WHERE` de todas las consultas, incluidas
 * las que ya reciben un id por la URL. Un `WHERE id_trabajador = ?` a secas dejaría
 * leer la ficha de cualquier trabajador del país cambiando el número.
 *
 * Es el espejo acotado de `planilla/trabajadores`, no una llamada a ese service: el del
 * estudio consulta sobre las 171 empresas y no filtra por ninguna.
 */
@Injectable()
export class PersonalClienteService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private archivos: ContratosArchivoService,
  ) {}

  /** Razón social y RUC de la empresa de la sesión, para encabezar las pantallas. */
  async miEmpresa(user: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const [row] = await this.dataSource.query(
      `SELECT id_empresa, razon_social, ruc, regimen_tributario
       FROM empresa
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!row) throw new NotFoundException('No se encontró la empresa asociada a tu usuario');
    return row;
  }

  async findAll(user: any, query: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const offset = (page - 1) * limit;

    // `t.id_empresa = ?` es lo PRIMERO del WHERE y no depende de ningún parámetro que
    // haya mandado el frontend. Los filtros de abajo solo pueden achicar el resultado.
    const where: string[] = ["t.estado_registro = 'ACTIVO'", 't.id_empresa = ?'];
    const params: any[] = [idEmpresa];

    if (query.search) {
      where.push(
        `(t.numero_documento LIKE ? OR CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) LIKE ? OR t.cargo LIKE ?)`,
      );
      const like = `%${query.search}%`;
      params.push(like, like, like);
    }

    // Por defecto solo el personal en actividad: el padrón histórico crece sin parar y
    // lo que la empresa mira a diario es quién está hoy en planilla.
    if (query.incluirCesados !== 'true') {
      where.push("t.cod_situacion <> '00' AND t.fecha_cese IS NULL");
    }

    if (query.area) {
      where.push('t.area = ?');
      params.push(query.area);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort) ? query.sort : 'apellido_paterno';
    const sortDir = query.dir === 'DESC' ? 'DESC' : 'ASC';

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT t.id_trabajador, t.numero_documento, t.cod_tipo_documento,
                CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_completo,
                t.cargo, t.area, t.fecha_ingreso, t.fecha_cese, t.cod_situacion,
                t.regimen_pensionario, a.nombre AS nombre_afp,
                r.nombre AS nombre_regimen,
                rem.sueldo_basico,
                (SELECT COUNT(*) FROM planilla_contrato c
                  WHERE c.id_trabajador = t.id_trabajador
                    AND c.estado_registro = 'ACTIVO' AND c.visible_cliente = 1) AS contratos
         FROM planilla_trabajador t
         JOIN planilla_regimen_laboral r ON r.id_regimen = t.id_regimen
         LEFT JOIN planilla_afp a ON a.id_afp = t.id_afp AND a.estado_registro = 'ACTIVO'
         LEFT JOIN (
           SELECT x.id_trabajador, x.sueldo_basico
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

  /**
   * Ficha del trabajador.
   *
   * Columnas EXPLÍCITAS y no `t.*`: la tabla del padrón guarda CUSPP, cuentas
   * bancarias, CCI y observaciones internas del estudio. Que la empresa sea la
   * empleadora no convierte a este endpoint en el lugar para exponer el número de
   * cuenta de nadie — para eso está la pantalla de la intranet, con sus permisos.
   */
  async findOne(user: any, id: number) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const [row] = await this.dataSource.query(
      `SELECT t.id_trabajador, t.numero_documento, t.cod_tipo_documento,
              t.apellido_paterno, t.apellido_materno, t.nombres,
              CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_completo,
              t.fecha_nacimiento, t.sexo, t.email, t.telefono,
              t.cargo, t.area, t.fecha_ingreso, t.fecha_cese, t.cod_situacion,
              t.cod_tipo_contrato, t.jornada_maxima, t.discapacidad, t.tiene_hijos_menores,
              t.regimen_pensionario, t.afecto_sctr,
              a.nombre AS nombre_afp, r.nombre AS nombre_regimen,
              rem.sueldo_basico, rem.vigencia_desde AS sueldo_vigente_desde
       FROM planilla_trabajador t
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
       WHERE t.id_trabajador = ? AND t.id_empresa = ? AND t.estado_registro = 'ACTIVO'`,
      [id, idEmpresa],
    );

    // Mismo mensaje para "no existe" y para "es de otra empresa". Distinguirlos
    // convertiría este endpoint en un detector de qué IDs están ocupados.
    if (!row) throw new NotFoundException('Trabajador no encontrado');
    return row;
  }

  /**
   * Contratos descargables de un trabajador.
   *
   * `visible_cliente = 1` además del scope de empresa: el estudio puede tener cargado
   * un borrador todavía sin firmar, y eso no se le muestra al cliente hasta que lo
   * marque como visible.
   */
  async findContratos(user: any, idTrabajador: number) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    // Confirma que el trabajador sea de su empresa ANTES de listar. Sin esto, un id
    // ajeno simplemente devolvería una lista vacía y no quedaría claro si la persona
    // no tiene contratos o si no es de esta empresa.
    await this.findOne(user, idTrabajador);

    return this.dataSource.query(
      `SELECT c.id_contrato, c.tipo, c.numero, c.descripcion, c.fecha_inicio, c.fecha_fin,
              c.archivo_nombre, c.archivo_tamano,
              CASE WHEN c.fecha_fin IS NULL OR c.fecha_fin >= CURDATE() THEN 1 ELSE 0 END AS vigente
       FROM planilla_contrato c
       WHERE c.id_trabajador = ? AND c.id_empresa = ?
         AND c.estado_registro = 'ACTIVO' AND c.visible_cliente = 1
       ORDER BY c.fecha_inicio DESC, c.id_contrato DESC`,
      [idTrabajador, idEmpresa],
    );
  }

  /**
   * Descarga el PDF del contrato.
   *
   * El `WHERE` vuelve a llevar `id_empresa` y `visible_cliente` aunque el listado ya
   * los haya aplicado: el cliente puede llamar a esta URL directamente con cualquier
   * id, sin pasar nunca por el listado. Cada endpoint valida por su cuenta.
   */
  async descargarContrato(user: any, idContrato: number, res: Response) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const [contrato] = await this.dataSource.query(
      `SELECT archivo_ruta, archivo_nombre FROM planilla_contrato
       WHERE id_contrato = ? AND id_empresa = ?
         AND estado_registro = 'ACTIVO' AND visible_cliente = 1`,
      [idContrato, idEmpresa],
    );
    if (!contrato) throw new NotFoundException('Contrato no encontrado');

    this.archivos.enviarPdf(contrato.archivo_ruta, contrato.archivo_nombre, res);
  }

  /** Áreas cargadas en el padrón de ESTA empresa — alimenta el filtro de la pantalla. */
  async areas(user: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    return this.dataSource.query(
      `SELECT DISTINCT area FROM planilla_trabajador
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO' AND area IS NOT NULL AND area <> ''
       ORDER BY area ASC`,
      [idEmpresa],
    );
  }
}

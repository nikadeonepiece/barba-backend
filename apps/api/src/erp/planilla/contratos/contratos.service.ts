import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { AuditoriaService } from '@app/common';
import { ContratosArchivoService } from './contratos-archivo.service';
import { CreateContratoDto, UpdateContratoDto } from './dto/contrato.dto';

const COLS_ORDER_ALLOWED = ['fecha_inicio', 'fecha_fin', 'tipo', 'apellido_paterno'];

/** `undefined`/`null` conserva lo que ya había; cualquier otra cosa se normaliza a 0/1. */
const bit = (v: any, actual: number): number => (v === undefined || v === null ? actual : v ? 1 : 0);
const val = <T>(v: T | undefined, actual: T): T => (v === undefined ? actual : v);

/**
 * Contratos y adendas — lado ESTUDIO.
 *
 * Acá se sube y se administra el legajo. Lo que ve la empresa cliente vive en
 * `erp/cliente/personal/`, con sus propias consultas acotadas por `id_empresa`: este
 * service NO filtra por empresa porque su usuario es del estudio y trabaja sobre las
 * 171. Mezclar los dos casos en un mismo método es exactamente cómo se cuela un IDOR.
 */
@Injectable()
export class ContratosService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private archivos: ContratosArchivoService,
  ) {}

  async findAll(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const offset = (page - 1) * limit;

    const where: string[] = ["c.estado_registro = 'ACTIVO'"];
    const params: any[] = [];

    const idEmpresa = Number(query.id_empresa);
    if (idEmpresa) {
      where.push('c.id_empresa = ?');
      params.push(idEmpresa);
    }

    const idTrabajador = Number(query.id_trabajador);
    if (idTrabajador) {
      where.push('c.id_trabajador = ?');
      params.push(idTrabajador);
    }

    if (query.tipo) {
      where.push('c.tipo = ?');
      params.push(query.tipo);
    }

    if (query.search) {
      where.push(
        `(t.numero_documento LIKE ? OR CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) LIKE ?
          OR c.numero LIKE ? OR c.descripcion LIKE ?)`,
      );
      const like = `%${query.search}%`;
      params.push(like, like, like, like);
    }

    // "Vigentes" = sin fecha de fin (plazo indeterminado) o con la fecha de fin
    // todavía por delante. Se compara contra `CURDATE()` de MySQL y no contra una
    // fecha armada en Node: un contrato que vence hoy caería del lado equivocado si
    // los dos relojes no coinciden.
    if (query.soloVigentes === 'true') {
      where.push('(c.fecha_fin IS NULL OR c.fecha_fin >= CURDATE())');
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort) ? query.sort : 'fecha_inicio';
    const sortDir = query.dir === 'ASC' ? 'ASC' : 'DESC';
    // `apellido_paterno` es de la tabla del trabajador y el resto del contrato: sin el
    // prefijo correcto, el ORDER BY revienta con "Unknown column".
    const sortSql = sortCol === 'apellido_paterno' ? `t.${sortCol}` : `c.${sortCol}`;

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT c.id_contrato, c.id_trabajador, c.id_empresa, c.tipo, c.numero, c.descripcion,
                c.fecha_inicio, c.fecha_fin, c.archivo_nombre, c.archivo_tamano,
                c.visible_cliente, c.observaciones,
                t.numero_documento, t.cargo,
                CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_trabajador,
                e.razon_social, e.ruc,
                CASE WHEN c.fecha_fin IS NULL OR c.fecha_fin >= CURDATE() THEN 1 ELSE 0 END AS vigente
         FROM planilla_contrato c
         JOIN planilla_trabajador t ON t.id_trabajador = c.id_trabajador
         JOIN empresa e ON e.id_empresa = c.id_empresa
         ${whereSql}
         ORDER BY ${sortSql} ${sortDir}, c.id_contrato DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total
         FROM planilla_contrato c
         JOIN planilla_trabajador t ON t.id_trabajador = c.id_trabajador
         ${whereSql}`,
        params,
      ),
    ]);

    return { data, meta: { total: Number(total), page, limit } };
  }

  /**
   * Buscador del `<ng-select>` de trabajadores del formulario de carga.
   *
   * ⚠️ Este es el PRIMER catálogo abierto del proyecto (crece con el negocio: hoy son
   * ~1 500 trabajadores entre las 171 empresas). CLAUDE.md § "ng-select regla 17"
   * dejaba el patrón pendiente para el primero que lo necesitara; este endpoint y el
   * `<ng-select>` de `contratos.ts` son esa referencia. Lo que hace y por qué:
   *
   * - **`LIMIT 30 + 1`**: se pide una fila DE MÁS para saber si hay página siguiente
   *   sin pagar un `COUNT(*)` sobre toda la tabla en cada tecla. Esa fila extra se
   *   descarta antes de responder; lo único que sobrevive es el booleano `hayMas`.
   * - **Prioridad del ID exacto** (`ORDER BY CASE WHEN id = ? ...`): sin esto, al
   *   ABRIR un contrato ya guardado el dropdown aparece VACÍO si ese trabajador cae
   *   fuera de los primeros 30 — el valor está en el form pero no hay opción que lo
   *   muestre, y parece que se borró.
   * - **Solo activos**: mismo motivo, un trabajador dado de baja no debe ofrecerse.
   */
  async buscarTrabajadores(query: any) {
    const limite = 30;
    const page = Number(query.page) || 1;
    const offset = (page - 1) * limite;

    const where: string[] = ["t.estado_registro = 'ACTIVO'"];
    const params: any[] = [];

    const idEmpresa = Number(query.id_empresa);
    if (idEmpresa) {
      where.push('t.id_empresa = ?');
      params.push(idEmpresa);
    }

    if (query.search) {
      where.push(
        `(t.numero_documento LIKE ? OR CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) LIKE ?)`,
      );
      const like = `%${query.search}%`;
      params.push(like, like);
    }

    // `id_seleccionado` es el trabajador que ya tiene guardado el registro en edición.
    // Va como parámetro del ORDER BY para empujarlo al primer lugar del resultado.
    const idSeleccionado = Number(query.id_seleccionado) || 0;

    const filas = await this.dataSource.query(
      `SELECT t.id_trabajador, t.numero_documento, t.cargo, t.id_empresa,
              CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_completo,
              e.razon_social
       FROM planilla_trabajador t
       JOIN empresa e ON e.id_empresa = t.id_empresa
       WHERE ${where.join(' AND ')}
       ORDER BY CASE WHEN t.id_trabajador = ? THEN 0 ELSE 1 END,
                t.apellido_paterno, t.apellido_materno, t.nombres
       LIMIT ? OFFSET ?`,
      [...params, idSeleccionado, limite + 1, offset],
    );

    const hayMas = filas.length > limite;
    return { data: hayMas ? filas.slice(0, limite) : filas, hayMas };
  }

  /** Empresas activas para el filtro. Precargado completo, igual que `planilla/trabajadores`. */
  async buscarEmpresas() {
    return this.dataSource.query(
      `SELECT id_empresa, razon_social, ruc FROM empresa
       WHERE estado_registro = 'ACTIVO' AND estado_cliente = 'ACTIVO'
       ORDER BY razon_social ASC`,
    );
  }

  async findOne(id: number) {
    const [row] = await this.dataSource.query(
      `SELECT c.*, t.numero_documento, t.cargo,
              CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_trabajador,
              e.razon_social, e.ruc
       FROM planilla_contrato c
       JOIN planilla_trabajador t ON t.id_trabajador = c.id_trabajador
       JOIN empresa e ON e.id_empresa = c.id_empresa
       WHERE c.id_contrato = ? AND c.estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!row) throw new NotFoundException('Contrato no encontrado');
    return row;
  }

  /**
   * Descarga desde la INTRANET. La del portal cliente es un método aparte
   * (`PersonalClienteService.descargarContrato`) porque tiene que acotar por empresa;
   * acá el usuario es del estudio y puede bajar el de cualquiera.
   */
  async descargar(id: number, res: Response) {
    const contrato = await this.findOne(id);
    this.archivos.enviarPdf(contrato.archivo_ruta, contrato.archivo_nombre, res);
  }

  async create(dto: CreateContratoDto, userId: number) {
    // La empresa NO viene del frontend: se lee del trabajador. Si la mandara el
    // cliente, el contrato quedaría archivado bajo una empresa que no es la suya y
    // aparecería en el portal equivocado.
    const [trabajador] = await this.dataSource.query(
      `SELECT id_trabajador, id_empresa FROM planilla_trabajador
       WHERE id_trabajador = ? AND estado_registro = 'ACTIVO'`,
      [dto.id_trabajador],
    );
    if (!trabajador) throw new NotFoundException('El trabajador no existe o está dado de baja');

    if (dto.fecha_fin && dto.fecha_fin < dto.fecha_inicio) {
      throw new BadRequestException(
        'La fecha de fin no puede ser anterior a la de inicio. Dejala vacía si el contrato es a plazo indeterminado.',
      );
    }

    // Confirma que el PDF exista en disco y mide su tamaño real. Con una ruta
    // inventada, la fila quedaría en BD apuntando a la nada y el error recién saldría
    // el día que alguien intente descargarla.
    const tamano = this.archivos.tamanoReal(dto.archivo_ruta);

    const res: any = await this.dataSource.query(
      `INSERT INTO planilla_contrato
         (id_trabajador, id_empresa, tipo, numero, descripcion, fecha_inicio, fecha_fin,
          archivo_ruta, archivo_nombre, archivo_tamano, visible_cliente, observaciones, id_usuario_crea)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dto.id_trabajador,
        trabajador.id_empresa,
        dto.tipo,
        dto.numero?.trim() || null,
        dto.descripcion?.trim() || null,
        dto.fecha_inicio,
        dto.fecha_fin || null,
        dto.archivo_ruta.trim(),
        dto.archivo_nombre.trim(),
        tamano,
        bit(dto.visible_cliente, 1),
        dto.observaciones?.trim() || null,
        userId,
      ],
    );

    const id = Number(res.insertId);
    await this.auditoriaService.registrar('planilla_contrato', id, 'CREAR', userId, null, {
      id_trabajador: dto.id_trabajador,
      tipo: dto.tipo,
      archivo_nombre: dto.archivo_nombre,
    });
    return { id, mensaje: 'Contrato cargado correctamente' };
  }

  async update(id: number, dto: UpdateContratoDto, userId: number) {
    const actual = await this.findOne(id);

    const fechaInicio = val(dto.fecha_inicio, actual.fecha_inicio);
    // Comparación contra `undefined`, no `||`: mandar `null` en `fecha_fin` es la forma
    // de pasar el contrato a plazo indeterminado. Con `||`, ese null caería al valor
    // anterior y el cambio se perdería sin que nadie lo note.
    const fechaFin = dto.fecha_fin === undefined ? actual.fecha_fin : dto.fecha_fin || null;

    if (fechaFin && String(fechaFin) < String(fechaInicio)) {
      throw new BadRequestException(
        'La fecha de fin no puede ser anterior a la de inicio. Dejala vacía si el contrato es a plazo indeterminado.',
      );
    }

    const res: any = await this.dataSource.query(
      `UPDATE planilla_contrato
       SET tipo = ?, numero = ?, descripcion = ?, fecha_inicio = ?, fecha_fin = ?,
           visible_cliente = ?, observaciones = ?, id_usuario_mod = ?
       WHERE id_contrato = ? AND estado_registro = 'ACTIVO'`,
      [
        val(dto.tipo, actual.tipo),
        dto.numero === undefined ? actual.numero : dto.numero?.trim() || null,
        dto.descripcion === undefined ? actual.descripcion : dto.descripcion?.trim() || null,
        fechaInicio,
        fechaFin,
        bit(dto.visible_cliente, actual.visible_cliente),
        dto.observaciones === undefined ? actual.observaciones : dto.observaciones?.trim() || null,
        userId,
        id,
      ],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Contrato no encontrado');

    await this.auditoriaService.registrar('planilla_contrato', id, 'ACTUALIZAR', userId, actual, dto);
    return { id, mensaje: 'Contrato actualizado' };
  }

  /**
   * Soft delete. El PDF NO se borra del disco a propósito: si la baja fue un error, el
   * archivo se recupera reactivando la fila. Un contrato laboral es la clase de
   * documento que se pide años después (inspección de SUNAFIL, juicio laboral), y
   * sacarlo de un backup cuesta mucho más que dejar unos MB ocupados.
   */
  async remove(id: number, userId: number) {
    const actual = await this.findOne(id);

    const res: any = await this.dataSource.query(
      `UPDATE planilla_contrato SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
       WHERE id_contrato = ? AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Contrato no encontrado');

    await this.auditoriaService.registrar('planilla_contrato', id, 'ELIMINAR', userId, actual, null);
    return { id, mensaje: 'Contrato dado de baja' };
  }
}

import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import { ExcelService, PdfHtmlService, AuditoriaService } from '@app/common';
import { empresaEfectiva, esUsuarioDePortal, asegurarEmpresaPropia } from '../scope-empresa';
import {
  CreateCategoriaDto, UpdateCategoriaDto,
  CreateSubcategoriaDto, UpdateSubcategoriaDto,
  CreateConceptoDto, UpdateConceptoDto,
} from './dto/centros-costo-config.dto';

/**
 * Centros de costo — el árbol EMPRESA → CATEGORÍA → SUBCATEGORÍA → CONCEPTO.
 *
 * Portado de `administracion/centros-costo-config` de Transportes Montero. Lo que
 * cambió al traerlo: allá la empresa salía de `cat_empresas_y_proveedores` y de una
 * segunda base; acá sale de `empresa`, que vive en la misma conexión, así que no hay
 * nombre de base escrito en ninguna query.
 *
 * ── La pantalla atiende a DOS públicos ──
 *
 * El ESTUDIO elige la empresa en un desplegable y puede ver las 171. Una cuenta de
 * PORTAL (un cliente) solo puede ver y tocar la suya.
 *
 * Esa diferencia se resuelve en UN solo lugar: `empresaEfectiva(user, filtro)`, que
 * para el portal devuelve siempre la empresa del token e IGNORA lo que haya mandado el
 * frontend. Todos los métodos de este service empiezan llamándola. Si alguno se olvida,
 * ese método deja ver los centros de costo de otra empresa cambiando un número en la
 * URL — es exactamente el IDOR que CLAUDE.md pide verificar.
 *
 * Las escrituras llevan además `asegurarEmpresaPropia()`: filtrar el listado no impide
 * que alguien mande un `PUT` con el id de una fila que nunca vio.
 */
@Injectable()
export class CentrosCostoConfigService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private readonly excelService: ExcelService,
    private readonly pdfHtmlService: PdfHtmlService,
  ) {}

  // ── PERTENENCIA ─────────────────────────────────────────────────────────────
  // De qué empresa es cada nivel del árbol. Se resuelve subiendo por los FK, que es la
  // única fuente que no puede contradecirse: la empresa está guardada solo en la
  // categoría.

  private async empresaDeCategoria(id: number): Promise<number | null> {
    const [fila] = await this.dataSource.query(
      `SELECT id_empresa FROM centro_costo_categoria WHERE id_centro_costo_categoria = ?`, [id],
    );
    return fila ? Number(fila.id_empresa) : null;
  }

  private async empresaDeSubcategoria(id: number): Promise<number | null> {
    const [fila] = await this.dataSource.query(
      `SELECT c.id_empresa
         FROM centro_costo_subcategoria s
         INNER JOIN centro_costo_categoria c ON c.id_centro_costo_categoria = s.id_centro_costo_categoria
        WHERE s.id_centro_costo_subcategoria = ?`,
      [id],
    );
    return fila ? Number(fila.id_empresa) : null;
  }

  private async empresaDeConcepto(id: number): Promise<number | null> {
    const [fila] = await this.dataSource.query(
      `SELECT c.id_empresa
         FROM centro_costo_concepto cc
         INNER JOIN centro_costo_subcategoria s ON s.id_centro_costo_subcategoria = cc.id_centro_costo_subcategoria
         INNER JOIN centro_costo_categoria c ON c.id_centro_costo_categoria = s.id_centro_costo_categoria
        WHERE cc.id_centro_costo_concepto = ?`,
      [id],
    );
    return fila ? Number(fila.id_empresa) : null;
  }

  // ── BÚSQUEDA DE CATÁLOGOS (ng-select) ──────────────────────────────────────
  //
  // `exactId` no es un capricho: sin él, al EDITAR un registro cuyo valor cae fuera de
  // las primeras 30 filas, el desplegable aparece vacío y el usuario cree que el dato
  // se perdió. El `ORDER BY CASE` lo trae primero pase lo que pase.

  /** Para una cuenta de portal devuelve SU empresa y nada más: no hay nada que elegir. */
  async buscarEmpresas(user: any, search = '', exactId?: number) {
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
        WHERE e.estado_registro = 'ACTIVO'
          AND (e.razon_social LIKE ? OR e.ruc LIKE ?)
        ${orderBy}
        LIMIT 30`,
      params,
    );
    return { data };
  }

  async buscarCategoriasSelect(user: any, search = '', idEmpresa?: number, exactId?: number) {
    const empresa = empresaEfectiva(user, idEmpresa);

    const conditions = [`c.estado_registro = 'ACTIVO'`, 'c.nombre LIKE ?'];
    const params: any[] = [`%${search}%`];
    if (empresa) { conditions.push('c.id_empresa = ?'); params.push(empresa); }

    let orderBy = 'ORDER BY c.nombre ASC';
    if (exactId) {
      orderBy = 'ORDER BY CASE WHEN c.id_centro_costo_categoria = ? THEN 0 ELSE 1 END, c.nombre ASC';
      params.push(exactId);
    }
    const data = await this.dataSource.query(
      `SELECT c.id_centro_costo_categoria AS id, c.nombre, c.id_empresa
         FROM centro_costo_categoria c
        WHERE ${conditions.join(' AND ')}
        ${orderBy}
        LIMIT 30`,
      params,
    );
    return { data };
  }

  /**
   * La subcategoría no guarda la empresa, así que para acotarla hay que subir hasta la
   * categoría. Sin este JOIN, un cliente que no manda `id_categoria` vería las
   * subcategorías de todas las empresas.
   */
  async buscarSubcategoriasSelect(user: any, search = '', idCategoria?: number, exactId?: number) {
    const empresa = empresaEfectiva(user, undefined);

    const conditions = [`s.estado_registro = 'ACTIVO'`, 's.nombre LIKE ?'];
    const params: any[] = [`%${search}%`];
    if (idCategoria) { conditions.push('s.id_centro_costo_categoria = ?'); params.push(idCategoria); }
    if (empresa) { conditions.push('c.id_empresa = ?'); params.push(empresa); }

    let orderBy = 'ORDER BY s.nombre ASC';
    if (exactId) {
      orderBy = 'ORDER BY CASE WHEN s.id_centro_costo_subcategoria = ? THEN 0 ELSE 1 END, s.nombre ASC';
      params.push(exactId);
    }
    const data = await this.dataSource.query(
      `SELECT s.id_centro_costo_subcategoria AS id, s.nombre, s.id_centro_costo_categoria
         FROM centro_costo_subcategoria s
         INNER JOIN centro_costo_categoria c ON c.id_centro_costo_categoria = s.id_centro_costo_categoria
        WHERE ${conditions.join(' AND ')}
        ${orderBy}
        LIMIT 30`,
      params,
    );
    return { data };
  }

  // ── CATEGORÍAS ──────────────────────────────────────────────────────────────

  async findAllCategorias(user: any, page = 1, limit = 20, search = '', idEmpresa?: number, isExport = false) {
    if (isExport) { page = 1; limit = 5000; }
    const offset = (page - 1) * limit;
    const like = `%${search}%`;
    const empresa = empresaEfectiva(user, idEmpresa);

    const joins = `
      FROM centro_costo_categoria c
      INNER JOIN empresa e ON e.id_empresa = c.id_empresa
    `;
    const conditions = [`c.estado_registro = 'ACTIVO'`, '(c.nombre LIKE ? OR e.razon_social LIKE ?)'];
    const params: any[] = [like, like];
    if (empresa) { conditions.push('c.id_empresa = ?'); params.push(empresa); }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const [data, countRaw] = await Promise.all([
      this.dataSource.query(
        `SELECT c.id_centro_costo_categoria, c.id_empresa, c.nombre,
                e.razon_social AS nombre_empresa, e.ruc,
                (SELECT COUNT(*) FROM centro_costo_subcategoria s2
                  WHERE s2.id_centro_costo_categoria = c.id_centro_costo_categoria
                    AND s2.estado_registro = 'ACTIVO') AS total_subcategorias
         ${joins} ${where}
         ORDER BY e.razon_social ASC, c.nombre ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total ${joins} ${where}`, params),
    ]);

    return {
      // `COUNT()` llega como STRING del driver de MySQL. Sin el `Number()`, el contador
      // de subcategorías viaja como '3' y cualquier comparación numérica en el front
      // (`> 0`, un orden) se hace contra texto.
      data: data.map((f: any) => ({ ...f, total_subcategorias: Number(f.total_subcategorias) })),
      meta: { total: Number(countRaw[0].total), page, limit },
    };
  }

  async createCategoria(dto: CreateCategoriaDto, user: any) {
    const userId = user.userId;
    // Para el portal la empresa sale del token: lo que mandó el formulario se descarta.
    const idEmpresa = empresaEfectiva(user, dto.id_empresa) ?? dto.id_empresa;
    const nombre = dto.nombre.trim().toUpperCase();

    const [empresa] = await this.dataSource.query(
      `SELECT id_empresa FROM empresa WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!empresa) throw new NotFoundException('La empresa seleccionada no existe o está dada de baja.');

    // Chequeo explícito además del UNIQUE: da un mensaje que nombra el conflicto. El
    // UNIQUE sigue siendo el que manda (dos usuarios simultáneos pasan los dos por
    // acá), y su error se traduce abajo.
    const duplicado = await this.dataSource.query(
      `SELECT id_centro_costo_categoria FROM centro_costo_categoria
        WHERE nombre = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [nombre, idEmpresa],
    );
    if (duplicado.length) throw new ConflictException('Ya existe una categoría con ese nombre para esta empresa.');

    try {
      const res = await this.dataSource.query(
        `INSERT INTO centro_costo_categoria (id_empresa, nombre, id_usuario_crea) VALUES (?, ?, ?)`,
        [idEmpresa, nombre, userId],
      );
      const id = Number(res.insertId);
      await this.auditoriaService.registrar('centro_costo_categoria', id, 'CREAR', userId, null, { ...dto, id_empresa: idEmpresa, nombre });
      return { id, mensaje: 'Categoría registrada correctamente' };
    } catch (error: any) {
      // El UNIQUE incluye las ELIMINADAS: el nombre de una categoría dada de baja
      // sigue ocupado y el chequeo de arriba (que solo mira ACTIVO) no lo ve.
      if (error?.code === 'ER_DUP_ENTRY') {
        throw new ConflictException(
          'Esta empresa ya tuvo una categoría con ese nombre. Si fue dada de baja, el nombre sigue ocupado: usá otro.',
        );
      }
      throw error;
    }
  }

  async updateCategoria(id: number, dto: UpdateCategoriaDto, user: any) {
    const userId = user.userId;
    const nombre = dto.nombre!.trim().toUpperCase();

    const [antiguo] = await this.dataSource.query(
      `SELECT * FROM centro_costo_categoria WHERE id_centro_costo_categoria = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!antiguo) throw new NotFoundException('La categoría no existe.');
    asegurarEmpresaPropia(user, antiguo.id_empresa);

    // El portal no puede MUDAR una categoría a otra empresa aunque mande otro id.
    const idEmpresa = empresaEfectiva(user, dto.id_empresa) ?? dto.id_empresa;

    const duplicado = await this.dataSource.query(
      `SELECT id_centro_costo_categoria FROM centro_costo_categoria
        WHERE nombre = ? AND id_empresa = ? AND id_centro_costo_categoria != ? AND estado_registro = 'ACTIVO'`,
      [nombre, idEmpresa, id],
    );
    if (duplicado.length) throw new ConflictException('Ya existe una categoría con ese nombre para esta empresa.');

    try {
      const res = await this.dataSource.query(
        `UPDATE centro_costo_categoria SET nombre = ?, id_empresa = ?, id_usuario_mod = ?
          WHERE id_centro_costo_categoria = ? AND estado_registro = 'ACTIVO'`,
        [nombre, idEmpresa, userId, id],
      );
      if (res.affectedRows === 0) throw new NotFoundException('La categoría no existe o ya fue eliminada.');
      await this.auditoriaService.registrar('centro_costo_categoria', id, 'ACTUALIZAR', userId, antiguo, { ...dto, id_empresa: idEmpresa, nombre });
      return { mensaje: 'Categoría actualizada correctamente' };
    } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe una categoría con ese nombre para esta empresa.');
      }
      throw error;
    }
  }

  async removeCategoria(id: number, user: any) {
    const userId = user.userId;

    const [antiguo] = await this.dataSource.query(
      `SELECT * FROM centro_costo_categoria WHERE id_centro_costo_categoria = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!antiguo) throw new NotFoundException('La categoría no existe.');
    asegurarEmpresaPropia(user, antiguo.id_empresa);

    // Baja en cascada NO: dejaría subcategorías y conceptos vivos colgando de una
    // categoría que ya no se lista, invisibles y sin forma de recuperarlos desde la UI.
    const [sub] = await this.dataSource.query(
      `SELECT id_centro_costo_subcategoria FROM centro_costo_subcategoria
        WHERE id_centro_costo_categoria = ? AND estado_registro = 'ACTIVO' LIMIT 1`,
      [id],
    );
    if (sub) {
      throw new ConflictException(
        'No se puede eliminar: la categoría tiene subcategorías activas. Eliminá primero las subcategorías (y sus conceptos).',
      );
    }

    const res = await this.dataSource.query(
      `UPDATE centro_costo_categoria SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
        WHERE id_centro_costo_categoria = ? AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('La categoría no existe o ya fue eliminada.');

    await this.auditoriaService.registrar('centro_costo_categoria', id, 'ELIMINAR', userId, antiguo, null);
    return { mensaje: 'Categoría eliminada correctamente' };
  }

  // ── SUBCATEGORÍAS ───────────────────────────────────────────────────────────

  async findAllSubcategorias(user: any, page = 1, limit = 20, search = '', idCategoria?: number, isExport = false) {
    if (isExport) { page = 1; limit = 5000; }
    const offset = (page - 1) * limit;
    const like = `%${search}%`;
    const empresa = empresaEfectiva(user, undefined);

    const joins = `
      FROM centro_costo_subcategoria s
      INNER JOIN centro_costo_categoria c ON c.id_centro_costo_categoria = s.id_centro_costo_categoria
      INNER JOIN empresa e ON e.id_empresa = c.id_empresa
    `;
    const conditions = [`s.estado_registro = 'ACTIVO'`, '(s.nombre LIKE ? OR c.nombre LIKE ? OR e.razon_social LIKE ?)'];
    const params: any[] = [like, like, like];
    if (idCategoria) { conditions.push('s.id_centro_costo_categoria = ?'); params.push(idCategoria); }
    if (empresa) { conditions.push('c.id_empresa = ?'); params.push(empresa); }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const [data, countRaw] = await Promise.all([
      this.dataSource.query(
        `SELECT s.id_centro_costo_subcategoria, s.id_centro_costo_categoria, s.nombre,
                c.nombre AS nombre_categoria, c.id_empresa,
                e.razon_social AS nombre_empresa,
                (SELECT COUNT(*) FROM centro_costo_concepto co2
                  WHERE co2.id_centro_costo_subcategoria = s.id_centro_costo_subcategoria
                    AND co2.estado_registro = 'ACTIVO') AS total_conceptos
         ${joins} ${where}
         ORDER BY e.razon_social ASC, c.nombre ASC, s.nombre ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total ${joins} ${where}`, params),
    ]);

    return {
      data: data.map((f: any) => ({ ...f, total_conceptos: Number(f.total_conceptos) })),
      meta: { total: Number(countRaw[0].total), page, limit },
    };
  }

  async createSubcategoria(dto: CreateSubcategoriaDto, user: any) {
    const userId = user.userId;
    const nombre = dto.nombre.trim().toUpperCase();

    const [cat] = await this.dataSource.query(
      `SELECT id_centro_costo_categoria, id_empresa FROM centro_costo_categoria
        WHERE id_centro_costo_categoria = ? AND estado_registro = 'ACTIVO'`,
      [dto.id_centro_costo_categoria],
    );
    if (!cat) throw new NotFoundException('La categoría seleccionada no existe.');
    // La categoría es la que decide la empresa: si es de otra, la subcategoría entera
    // caería del lado equivocado del árbol.
    asegurarEmpresaPropia(user, cat.id_empresa);

    const duplicado = await this.dataSource.query(
      `SELECT id_centro_costo_subcategoria FROM centro_costo_subcategoria
        WHERE nombre = ? AND id_centro_costo_categoria = ? AND estado_registro = 'ACTIVO'`,
      [nombre, dto.id_centro_costo_categoria],
    );
    if (duplicado.length) throw new ConflictException('Ya existe una subcategoría con ese nombre en esta categoría.');

    try {
      const res = await this.dataSource.query(
        `INSERT INTO centro_costo_subcategoria (id_centro_costo_categoria, nombre, id_usuario_crea) VALUES (?, ?, ?)`,
        [dto.id_centro_costo_categoria, nombre, userId],
      );
      const id = Number(res.insertId);
      await this.auditoriaService.registrar('centro_costo_subcategoria', id, 'CREAR', userId, null, { ...dto, nombre });
      return { id, mensaje: 'Subcategoría registrada correctamente' };
    } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') {
        throw new ConflictException(
          'Esta categoría ya tuvo una subcategoría con ese nombre. Si fue dada de baja, el nombre sigue ocupado: usá otro.',
        );
      }
      throw error;
    }
  }

  async updateSubcategoria(id: number, dto: UpdateSubcategoriaDto, user: any) {
    const userId = user.userId;
    const nombre = dto.nombre!.trim().toUpperCase();

    const [antiguo] = await this.dataSource.query(
      `SELECT * FROM centro_costo_subcategoria WHERE id_centro_costo_subcategoria = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!antiguo) throw new NotFoundException('La subcategoría no existe.');
    asegurarEmpresaPropia(user, await this.empresaDeSubcategoria(id));
    // Las DOS puntas: la de donde sale y la de donde va. Verificar solo la vieja
    // dejaría mudar una subcategoría propia a la categoría de otra empresa.
    asegurarEmpresaPropia(user, await this.empresaDeCategoria(dto.id_centro_costo_categoria!));

    const duplicado = await this.dataSource.query(
      `SELECT id_centro_costo_subcategoria FROM centro_costo_subcategoria
        WHERE nombre = ? AND id_centro_costo_categoria = ? AND id_centro_costo_subcategoria != ? AND estado_registro = 'ACTIVO'`,
      [nombre, dto.id_centro_costo_categoria, id],
    );
    if (duplicado.length) throw new ConflictException('Ya existe una subcategoría con ese nombre en esta categoría.');

    try {
      const res = await this.dataSource.query(
        `UPDATE centro_costo_subcategoria SET nombre = ?, id_centro_costo_categoria = ?, id_usuario_mod = ?
          WHERE id_centro_costo_subcategoria = ? AND estado_registro = 'ACTIVO'`,
        [nombre, dto.id_centro_costo_categoria, userId, id],
      );
      if (res.affectedRows === 0) throw new NotFoundException('La subcategoría no existe o ya fue eliminada.');
      await this.auditoriaService.registrar('centro_costo_subcategoria', id, 'ACTUALIZAR', userId, antiguo, { ...dto, nombre });
      return { mensaje: 'Subcategoría actualizada correctamente' };
    } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe una subcategoría con ese nombre en esta categoría.');
      }
      throw error;
    }
  }

  async removeSubcategoria(id: number, user: any) {
    const userId = user.userId;

    const [antiguo] = await this.dataSource.query(
      `SELECT * FROM centro_costo_subcategoria WHERE id_centro_costo_subcategoria = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!antiguo) throw new NotFoundException('La subcategoría no existe.');
    asegurarEmpresaPropia(user, await this.empresaDeSubcategoria(id));

    const [con] = await this.dataSource.query(
      `SELECT id_centro_costo_concepto FROM centro_costo_concepto
        WHERE id_centro_costo_subcategoria = ? AND estado_registro = 'ACTIVO' LIMIT 1`,
      [id],
    );
    if (con) {
      throw new ConflictException('No se puede eliminar: la subcategoría tiene conceptos activos. Eliminá primero los conceptos.');
    }

    const res = await this.dataSource.query(
      `UPDATE centro_costo_subcategoria SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
        WHERE id_centro_costo_subcategoria = ? AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('La subcategoría no existe o ya fue eliminada.');

    await this.auditoriaService.registrar('centro_costo_subcategoria', id, 'ELIMINAR', userId, antiguo, null);
    return { mensaje: 'Subcategoría eliminada correctamente' };
  }

  // ── CONCEPTOS ───────────────────────────────────────────────────────────────

  // `ORDER BY` dinámico: la columna NUNCA sale del query string directo — se traduce
  // por esta whitelist, que es la regla de CLAUDE.md para ordenamientos configurables.
  private static readonly COLS_ORDER_CONCEPTOS: Record<string, string> = {
    id: 'co.id_centro_costo_concepto',
    nombre: 'co.nombre',
    subcategoria: 's.nombre',
    categoria: 'c.nombre',
    empresa: 'e.razon_social',
  };

  async findAllConceptos(
    user: any, page = 1, limit = 20, search = '',
    idSubcategoria?: number, idCategoria?: number, idEmpresa?: number,
    sortCol = 'empresa', sortDir: 'ASC' | 'DESC' = 'ASC', isExport = false,
  ) {
    if (isExport) { page = 1; limit = 5000; }
    const offset = (page - 1) * limit;
    const like = `%${search}%`;
    const empresa = empresaEfectiva(user, idEmpresa);

    const joins = `
      FROM centro_costo_concepto co
      INNER JOIN centro_costo_subcategoria s ON s.id_centro_costo_subcategoria = co.id_centro_costo_subcategoria
      INNER JOIN centro_costo_categoria   c ON c.id_centro_costo_categoria     = s.id_centro_costo_categoria
      INNER JOIN empresa e ON e.id_empresa = c.id_empresa
    `;
    const conditions = [
      `co.estado_registro = 'ACTIVO'`,
      '(co.nombre LIKE ? OR s.nombre LIKE ? OR c.nombre LIKE ? OR e.razon_social LIKE ?)',
    ];
    const params: any[] = [like, like, like, like];
    if (idSubcategoria) { conditions.push('co.id_centro_costo_subcategoria = ?'); params.push(idSubcategoria); }
    if (idCategoria)    { conditions.push('s.id_centro_costo_categoria = ?');     params.push(idCategoria); }
    if (empresa)        { conditions.push('c.id_empresa = ?');                    params.push(empresa); }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const col = CentrosCostoConfigService.COLS_ORDER_CONCEPTOS[sortCol] ?? 'e.razon_social';
    const dir = sortDir === 'DESC' ? 'DESC' : 'ASC';

    const [data, countRaw] = await Promise.all([
      this.dataSource.query(
        `SELECT co.id_centro_costo_concepto, co.id_centro_costo_subcategoria, co.nombre,
                s.nombre AS nombre_subcategoria, s.id_centro_costo_categoria,
                c.nombre AS nombre_categoria, c.id_empresa,
                e.razon_social AS nombre_empresa
         ${joins} ${where}
         ORDER BY ${col} ${dir}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total ${joins} ${where}`, params),
    ]);

    return { data, meta: { total: Number(countRaw[0].total), page, limit } };
  }

  async createConcepto(dto: CreateConceptoDto, user: any) {
    const userId = user.userId;
    const nombre = dto.nombre.trim().toUpperCase();

    const [sub] = await this.dataSource.query(
      `SELECT id_centro_costo_subcategoria FROM centro_costo_subcategoria
        WHERE id_centro_costo_subcategoria = ? AND estado_registro = 'ACTIVO'`,
      [dto.id_centro_costo_subcategoria],
    );
    if (!sub) throw new NotFoundException('La subcategoría seleccionada no existe.');
    asegurarEmpresaPropia(user, await this.empresaDeSubcategoria(dto.id_centro_costo_subcategoria));

    const duplicado = await this.dataSource.query(
      `SELECT id_centro_costo_concepto FROM centro_costo_concepto
        WHERE nombre = ? AND id_centro_costo_subcategoria = ? AND estado_registro = 'ACTIVO'`,
      [nombre, dto.id_centro_costo_subcategoria],
    );
    if (duplicado.length) throw new ConflictException('Ya existe un concepto con ese nombre en esta subcategoría.');

    try {
      const res = await this.dataSource.query(
        `INSERT INTO centro_costo_concepto (id_centro_costo_subcategoria, nombre, id_usuario_crea) VALUES (?, ?, ?)`,
        [dto.id_centro_costo_subcategoria, nombre, userId],
      );
      const id = Number(res.insertId);
      await this.auditoriaService.registrar('centro_costo_concepto', id, 'CREAR', userId, null, { ...dto, nombre });
      return { id, mensaje: 'Concepto registrado correctamente' };
    } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') {
        throw new ConflictException(
          'Esta subcategoría ya tuvo un concepto con ese nombre. Si fue dado de baja, el nombre sigue ocupado: usá otro.',
        );
      }
      throw error;
    }
  }

  async updateConcepto(id: number, dto: UpdateConceptoDto, user: any) {
    const userId = user.userId;
    const nombre = dto.nombre!.trim().toUpperCase();

    const [antiguo] = await this.dataSource.query(
      `SELECT * FROM centro_costo_concepto WHERE id_centro_costo_concepto = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!antiguo) throw new NotFoundException('El concepto no existe.');
    asegurarEmpresaPropia(user, await this.empresaDeConcepto(id));
    asegurarEmpresaPropia(user, await this.empresaDeSubcategoria(dto.id_centro_costo_subcategoria!));

    const duplicado = await this.dataSource.query(
      `SELECT id_centro_costo_concepto FROM centro_costo_concepto
        WHERE nombre = ? AND id_centro_costo_subcategoria = ? AND id_centro_costo_concepto != ? AND estado_registro = 'ACTIVO'`,
      [nombre, dto.id_centro_costo_subcategoria, id],
    );
    if (duplicado.length) throw new ConflictException('Ya existe un concepto con ese nombre en esta subcategoría.');

    try {
      const res = await this.dataSource.query(
        `UPDATE centro_costo_concepto SET nombre = ?, id_centro_costo_subcategoria = ?, id_usuario_mod = ?
          WHERE id_centro_costo_concepto = ? AND estado_registro = 'ACTIVO'`,
        [nombre, dto.id_centro_costo_subcategoria, userId, id],
      );
      if (res.affectedRows === 0) throw new NotFoundException('El concepto no existe o ya fue eliminado.');
      await this.auditoriaService.registrar('centro_costo_concepto', id, 'ACTUALIZAR', userId, antiguo, { ...dto, nombre });
      return { mensaje: 'Concepto actualizado correctamente' };
    } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe un concepto con ese nombre en esta subcategoría.');
      }
      throw error;
    }
  }

  async removeConcepto(id: number, user: any) {
    const userId = user.userId;

    const [antiguo] = await this.dataSource.query(
      `SELECT * FROM centro_costo_concepto WHERE id_centro_costo_concepto = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!antiguo) throw new NotFoundException('El concepto no existe.');
    asegurarEmpresaPropia(user, await this.empresaDeConcepto(id));

    // Un concepto ya imputado no se da de baja: el movimiento o el requerimiento que lo
    // usa quedaría apuntando a algo que la pantalla ya no muestra.
    const [enUso] = await this.dataSource.query(
      `SELECT 1 AS usado FROM requerimiento_detalle
        WHERE id_centro_costo_concepto = ? AND estado_registro = 'ACTIVO' LIMIT 1`,
      [id],
    );
    if (enUso) {
      throw new ConflictException(
        'No se puede eliminar: este concepto ya está usado en algún requerimiento. ' +
        'Si no se usa más, dejá de elegirlo — su historial tiene que seguir consultable.',
      );
    }

    const res = await this.dataSource.query(
      `UPDATE centro_costo_concepto SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
        WHERE id_centro_costo_concepto = ? AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('El concepto no existe o ya fue eliminado.');

    await this.auditoriaService.registrar('centro_costo_concepto', id, 'ELIMINAR', userId, antiguo, null);
    return { mensaje: 'Concepto eliminado correctamente' };
  }

  // ── EXPORTACIÓN ─────────────────────────────────────────────────────────────

  private async obtenerDatosExport(user: any, tipo: string, query: any) {
    const search = query.search || '';

    if (tipo === 'categorias') {
      const { data } = await this.findAllCategorias(
        user, 1, 5000, search, query.id_empresa ? Number(query.id_empresa) : undefined, true,
      );
      return {
        titulo: 'Categorías de Centro de Costo',
        columnas: [
          { header: 'ID',            key: 'id_centro_costo_categoria', width: 8 },
          { header: 'NOMBRE',        key: 'nombre', width: 40 },
          { header: 'EMPRESA',       key: 'nombre_empresa', width: 40 },
          { header: 'RUC',           key: 'ruc', width: 14 },
          { header: 'SUBCATEGORÍAS', key: 'total_subcategorias', width: 14 },
        ],
        data,
      };
    }

    if (tipo === 'subcategorias') {
      const { data } = await this.findAllSubcategorias(
        user, 1, 5000, search, query.id_categoria ? Number(query.id_categoria) : undefined, true,
      );
      return {
        titulo: 'Subcategorías de Centro de Costo',
        columnas: [
          { header: 'ID',        key: 'id_centro_costo_subcategoria', width: 8 },
          { header: 'NOMBRE',    key: 'nombre', width: 40 },
          { header: 'CATEGORÍA', key: 'nombre_categoria', width: 40 },
          { header: 'EMPRESA',   key: 'nombre_empresa', width: 40 },
          { header: 'CONCEPTOS', key: 'total_conceptos', width: 12 },
        ],
        data,
      };
    }

    if (tipo === 'conceptos') {
      const { data } = await this.findAllConceptos(
        user, 1, 5000, search,
        query.id_subcategoria ? Number(query.id_subcategoria) : undefined,
        query.id_categoria ? Number(query.id_categoria) : undefined,
        query.id_empresa ? Number(query.id_empresa) : undefined,
        'empresa', 'ASC', true,
      );
      return {
        titulo: 'Conceptos de Centro de Costo',
        columnas: [
          { header: 'ID',           key: 'id_centro_costo_concepto', width: 8 },
          { header: 'NOMBRE',       key: 'nombre', width: 40 },
          { header: 'SUBCATEGORÍA', key: 'nombre_subcategoria', width: 40 },
          { header: 'CATEGORÍA',    key: 'nombre_categoria', width: 40 },
          { header: 'EMPRESA',      key: 'nombre_empresa', width: 40 },
        ],
        data,
      };
    }

    throw new BadRequestException('Tipo de reporte inválido. Use: categorias, subcategorias o conceptos.');
  }

  async exportarExcel(user: any, tipo: string, query: any, res: Response) {
    const { titulo, columnas, data } = await this.obtenerDatosExport(user, tipo, query);
    await this.excelService.generarExcel(
      columnas, data, `${titulo.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}`, titulo, res,
    );
  }

  /**
   * `PdfHtmlService` y no `PdfService`: el reporte se arma como HTML con estilos
   * inline, que es lo que ese servicio convierte. `PdfService` espera un
   * `TDocumentDefinitions` de pdfmake y pasarle este string no falla al compilar —
   * falla al abrir el PDF.
   */
  async exportarPdf(user: any, tipo: string, query: any, res: Response) {
    const { titulo, columnas, data } = await this.obtenerDatosExport(user, tipo, query);

    const anchoCol = (100 / columnas.length).toFixed(2);
    const filas = data
      .map((item: any) => `<tr>${columnas.map((c) => `<td>${item[c.key] ?? '—'}</td>`).join('')}</tr>`)
      .join('');

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
    </style></head><body>
    <div class="header">
        <h2>Estudio Contable Barba</h2>
        <p style="margin:4px 0 0">Centros de Costo — Configuración</p>
        <h1>${titulo.toUpperCase()}</h1>
        <p style="margin:4px 0 0">Generado el: ${new Date().toLocaleString('es-PE')} · Total: ${data.length} registros</p>
    </div>
    <table>
        <thead><tr>${columnas.map((c) => `<th style="width:${anchoCol}%">${c.header}</th>`).join('')}</tr></thead>
        <tbody>${filas || `<tr><td colspan="${columnas.length}" style="padding:30px;color:#94a3b8">Sin registros para los filtros aplicados</td></tr>`}</tbody>
    </table>
    <div class="footer">Documento generado automáticamente por el ERP del Estudio Barba</div>
    </body></html>`;

    await this.pdfHtmlService.generarPdf(
      html, `${titulo.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}`, res, { landscape: true },
    );
  }
}

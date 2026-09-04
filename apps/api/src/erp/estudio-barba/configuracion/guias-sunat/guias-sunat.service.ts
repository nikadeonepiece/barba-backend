import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { AuditoriaService, PdfService } from '@app/common';
import { CreateGuiaSunatDto, UpdateGuiaSunatDto } from './dto/guia-sunat.dto';

const COLS_ORDER_ALLOWED = ['id_guia', 'codigo', 'nombre'];

@Injectable()
export class GuiasSunatService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private pdfService: PdfService,
  ) {}

  async findAll(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;

    const where: string[] = ["t.estado = 'ACTIVO'"];
    const params: any[] = [];

    if (query.search) {
      where.push('(t.codigo LIKE ? OR t.nombre LIKE ?)');
      params.push(`%${query.search}%`, `%${query.search}%`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort) ? query.sort : 'codigo';
    const sortDir = query.dir === 'DESC' ? 'DESC' : 'ASC';

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT t.id_guia, t.codigo, t.nombre, t.pasos, t.estado
         FROM guias_sunat t
         ${whereSql}
         ORDER BY t.${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total FROM guias_sunat t ${whereSql}`, params),
    ]);

    return { data, meta: { total: Number(total), page, limit } };
  }

  async findOne(id: number) {
    const [row] = await this.dataSource.query(
      `SELECT t.* FROM guias_sunat t WHERE t.id_guia = ? AND t.estado = 'ACTIVO'`,
      [id],
    );
    if (!row) throw new NotFoundException('Guía no encontrada');
    return row;
  }

  async create(dto: CreateGuiaSunatDto, userId: number) {
    try {
      const res: any = await this.dataSource.query(
        `INSERT INTO guias_sunat (codigo, nombre, pasos, estado, id_usuario_crea)
         VALUES (?, ?, ?, 'ACTIVO', ?)`,
        [dto.codigo.trim(), dto.nombre.trim(), dto.pasos.trim(), userId],
      );
      const idNuevo = Number(res.insertId);
      await this.auditoriaService.registrar('guias_sunat', idNuevo, 'CREAR', userId, null, dto);
      return { id: idNuevo };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') throw new ConflictException('Ya existe una guía con ese código');
      throw error;
    }
  }

  async update(id: number, dto: UpdateGuiaSunatDto, userId: number) {
    const oldValues = await this.findOne(id);

    try {
      const res: any = await this.dataSource.query(
        `UPDATE guias_sunat SET codigo = ?, nombre = ?, pasos = ?, estado = ?, id_usuario_mod = ?
         WHERE id_guia = ? AND estado = 'ACTIVO'`,
        [
          dto.codigo?.trim() ?? oldValues.codigo,
          dto.nombre?.trim() ?? oldValues.nombre,
          dto.pasos?.trim() ?? oldValues.pasos,
          dto.estado ?? oldValues.estado,
          userId,
          id,
        ],
      );
      if (res.affectedRows === 0) throw new NotFoundException('Guía no encontrada');

      await this.auditoriaService.registrar('guias_sunat', id, 'ACTUALIZAR', userId, oldValues, dto);
      return { id };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') throw new ConflictException('Ya existe una guía con ese código');
      throw error;
    }
  }

  // Exporta una guía como PDF (paso a paso numerado) para leerla luego sin depender
  // del navegador ni de estar logueado en el ERP.
  async exportarPdf(id: number, res: Response) {
    const guia = await this.findOne(id);

    // Los pasos ya vienen numerados a mano en el texto guardado ("1. Entrar a...") —
    // se quita ese número al inicio de cada línea para que pdfmake los renumere solo
    // con `ol` y no queden doble numerados ("1. 1. Entrar a...").
    const pasos: string[] = (guia.pasos || '')
      .split('\n')
      .map((p: string) => p.trim().replace(/^\d+\.\s*/, ''))
      .filter((p: string) => p.length > 0);

    await this.pdfService.generarPdf(
      {
        pageMargins: [30, 30, 30, 30],
        content: [
          { text: `Guía SUNAT — ${guia.codigo}`, fontSize: 14, bold: true },
          { text: guia.nombre, fontSize: 11, color: '#333333', margin: [0, 2, 0, 16] },
          { ol: pasos, fontSize: 10, margin: [0, 0, 0, 0] },
        ],
        defaultStyle: { font: 'Helvetica' },
      },
      `guia-sunat-${guia.codigo}`,
      res,
    );
  }

  async remove(id: number, userId: number) {
    const oldValues = await this.findOne(id);

    const res: any = await this.dataSource.query(
      `UPDATE guias_sunat SET estado = 'INACTIVO', id_usuario_mod = ? WHERE id_guia = ? AND estado = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Guía no encontrada');

    await this.auditoriaService.registrar('guias_sunat', id, 'ELIMINAR', userId, oldValues, null);
    return { id };
  }
}

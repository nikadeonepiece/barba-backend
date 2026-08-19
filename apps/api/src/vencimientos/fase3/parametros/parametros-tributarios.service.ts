import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditoriaService } from '@app/common';
import { UpsertParametroDto } from './dto/parametro-tributario.dto';

/**
 * Tabla que la capa de IA (Fase 3) usa para citar cifras reales en vez de
 * confiar en lo que el modelo "recuerda" de su entrenamiento (UIT, RMV, tasas).
 * CRUD simple, sin stored procedure porque no forma parte del core intocable.
 */
@Injectable()
export class ParametrosTributariosService {
  constructor(
    @InjectDataSource('DENTAONEPIECE_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
  ) {}

  async upsert(dto: UpsertParametroDto, userId: number) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const codigo = dto.codigo.toUpperCase();
      const [oldValues] = await queryRunner.query(
        `SELECT id_parametro, anio, codigo, valor, descripcion FROM parametro_tributario WHERE anio = ? AND codigo = ?`,
        [dto.anio, codigo],
      );

      const [result]: any = await queryRunner.query(
        `INSERT INTO parametro_tributario (anio, codigo, valor, descripcion)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE valor = VALUES(valor), descripcion = VALUES(descripcion)`,
        [dto.anio, codigo, dto.valor, dto.descripcion ?? null],
      );
      const idParametro = oldValues ? oldValues.id_parametro : Number(result.insertId);

      await this.auditoriaService.registrarConTransaccion(
        queryRunner, 'parametro_tributario', idParametro, oldValues ? 'ACTUALIZAR' : 'CREAR', userId, oldValues ?? null, dto,
      );
      await queryRunner.commitTransaction();
      return { success: true, message: 'Parámetro guardado' };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async listarPorAnio(anio: number) {
    const data = await this.dataSource.query(
      `SELECT codigo, valor, descripcion FROM parametro_tributario WHERE anio = ? AND estado_registro = 'ACTIVO' ORDER BY codigo ASC`,
      [anio],
    );
    return { success: true, data };
  }
}

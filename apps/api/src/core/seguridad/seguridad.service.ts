import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditoriaService } from '@app/common';
import { CreateRolDto } from './rol.dto';

@Injectable()
export class SeguridadService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private readonly auditoriaService: AuditoriaService
  ) {}

  async getPermisosPorRol(idRol: number) {
    // El rol 1 (SUPERADMIN) siempre tiene acceso total, sin depender de sis_permiso
    // (mismo criterio ya aplicado en updateRol/removeRol/updatePermisosRol de este archivo).
    if (idRol === 1) {
      const result = await this.dataSource.query(
        `SELECT codigo_accion AS codigo FROM sis_accion WHERE estado_registro = 'ACTIVO'`
      );
      return result.map((row: any) => row.codigo);
    }
    const result = await this.dataSource.query(`CALL sis_permiso_obtener_por_rol(?)`, [idRol]);
    return result[0].map((row: any) => row.codigo);
  }

  // --- LÓGICA DE ROLES ---
  async getRoles() {
    const result = await this.dataSource.query(`CALL sis_rol_listar()`);
    return result[0];
  }

  async createRol(dto: CreateRolDto, userId: number) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await queryRunner.query(
        `CALL sis_rol_crear(?, ?)`,
        [dto.nombre.trim().toUpperCase(), dto.descripcion ? dto.descripcion.trim() : null]
      );
      const id = result[0][0].id_insertado;
      await this.auditoriaService.registrarConTransaccion(queryRunner, 'sis_rol', id, 'CREAR', userId, null, dto);
      await queryRunner.commitTransaction();
      // Se devuelve el id: la pantalla deja seleccionado el rol recien creado para
      // marcarle los permisos ahi mismo. Sin esto tenia que buscarlo en el combo.
      return { success: true, message: 'Rol creado exitosamente', data: { id_insertado: id } };
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      if (error.message.includes('uk_nombre_rol')) throw new ConflictException('El nombre del rol ya existe.');
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updateRol(id: number, dto: CreateRolDto, userId: number) {
    if (id === 1) throw new ConflictException('El rol de ADMINISTRADOR principal no puede ser modificado.');
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const [oldValues] = await queryRunner.query(`SELECT id_rol, nombre, descripcion FROM sis_rol WHERE id_rol = ?`, [id]);
      if (!oldValues) throw new NotFoundException('Rol no encontrado');

      await queryRunner.query(
        `CALL sis_rol_actualizar(?, ?, ?)`,
        [id, dto.nombre.trim().toUpperCase(), dto.descripcion ? dto.descripcion.trim() : null]
      );
      await this.auditoriaService.registrarConTransaccion(queryRunner, 'sis_rol', id, 'ACTUALIZAR', userId, oldValues, dto);
      await queryRunner.commitTransaction();
      return { success: true, message: 'Rol actualizado exitosamente' };
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async removeRol(id: number, userId: number) {
    if (id === 1) throw new ConflictException('El rol de ADMINISTRADOR principal no puede ser eliminado.');
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const [oldValues] = await queryRunner.query(`SELECT id_rol, nombre, descripcion FROM sis_rol WHERE id_rol = ?`, [id]);
      if (!oldValues) throw new NotFoundException('Rol no encontrado');

      await queryRunner.query(`CALL sis_rol_eliminar(?)`, [id]);
      await this.auditoriaService.registrarConTransaccion(queryRunner, 'sis_rol', id, 'ELIMINAR', userId, oldValues, null);
      await queryRunner.commitTransaction();
      return { success: true, message: 'Rol eliminado' };
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      if (error.sqlState === '45000') throw new ConflictException(error.message);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // --- LÓGICA DE MATRIZ ---
  async getMatrizModulos() {
    const result = await this.dataSource.query(`CALL sis_matriz_modulos_listar()`);
    const rows = result[0];
    const modulosMap = new Map<number, any>();
    for (const row of rows) {
      if (!modulosMap.has(row.id_modulo)) {
        modulosMap.set(row.id_modulo, { id_modulo: row.id_modulo, etiqueta: row.etiqueta, acciones: [] });
      }
      if (row.id_accion) {
        modulosMap.get(row.id_modulo).acciones.push({
          id_accion: row.id_accion,
          id_modulo: row.id_modulo,
          codigo: row.codigo,
          descripcion: row.descripcion
        });
      }
    }
    return Array.from(modulosMap.values());
  }

  async getPermisosIds(idRol: number) {
    const result = await this.dataSource.query(`CALL sis_permiso_ids_por_rol(?)`, [idRol]);
    return result[0].map((r: any) => r.id_accion);
  }

  async updatePermisosRol(idRol: number, accionesIds: number[]) {
    if (idRol === 1) throw new ConflictException('El rol de ADMINISTRADOR principal siempre tiene todos los permisos y no puede alterarse.');
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(`CALL sis_permiso_limpiar_rol(?)`, [idRol]);
      if (accionesIds && accionesIds.length > 0) {
        for (const idAccion of accionesIds) {
          await queryRunner.query(`CALL sis_permiso_asignar(?, ?)`, [idRol, idAccion]);
        }
      }
      await queryRunner.commitTransaction();
      return { success: true, message: 'Matriz de permisos actualizada correctamente' };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

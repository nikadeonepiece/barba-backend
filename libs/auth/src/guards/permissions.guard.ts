import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<{ modulo: string, accion: string }>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.roleId) {
      throw new ForbiddenException('No se pudo identificar el rol del usuario.');
    }

    // El rol 1 (SUPERADMIN) siempre tiene acceso total, sin depender de sis_permiso
    // (mismo criterio ya aplicado en seguridad.service.ts para updateRol/removeRol/updatePermisosRol/getPermisosPorRol).
    if (user.roleId === 1) {
      return true;
    }

    // Consulta SQL 100% adaptada a la estructura de la BD bd_tirno
    const query = `
      SELECT 1 
      FROM sis_permiso p
      INNER JOIN sis_accion a ON p.id_accion = a.id_accion
      INNER JOIN sis_modulo m ON a.id_modulo = m.id_modulo
      WHERE p.id_rol = ? 
        AND m.nombre = ? 
        AND a.codigo_accion = ? 
        AND m.estado_registro = 'ACTIVO'
      LIMIT 1;
    `;

    const result = await this.dataSource.query(query, [
      user.roleId, 
      requiredPermissions.modulo, 
      requiredPermissions.accion
    ]);

    if (result.length > 0) {
      return true;
    } else {
      throw new ForbiddenException(`Permiso denegado. Se requiere la acción '${requiredPermissions.accion}' en el módulo '${requiredPermissions.modulo}'.`);
    }
  }
}
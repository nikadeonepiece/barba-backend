import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Req, UnauthorizedException, ParseIntPipe } from '@nestjs/common';
import { SeguridadService } from './seguridad.service';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { CreateRolDto } from './rol.dto';

@Controller('seguridad')
@UseGuards(JwtAuthGuard, PermissionsGuard) 
export class SeguridadController {
  constructor(private readonly seguridadService: SeguridadService) {}

  @Get('permisos')
  async misPermisos(@Req() req: any) {
    const user = req.user;
    if (!user || !user.roleId) throw new UnauthorizedException('Token inválido o sin rol');
    const permisos = await this.seguridadService.getPermisosPorRol(user.roleId);
    return { permisos };
  }

  // --- CRUD DE ROLES ---
  @RequirePermissions('SEGURIDAD', 'ver_seguridad')
  @Get('roles')
  async getRoles() {
    return { success: true, data: await this.seguridadService.getRoles() };
  }

  @RequirePermissions('SEGURIDAD', 'crear_seguridad')
  @Post('roles')
  async createRol(@Body() dto: CreateRolDto, @Req() req: any) {
    return this.seguridadService.createRol(dto, req.user.userId);
  }

  @RequirePermissions('SEGURIDAD', 'actualizar_seguridad')
  @Put('roles/:id')
  async updateRol(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateRolDto, @Req() req: any) {
    return this.seguridadService.updateRol(id, dto, req.user.userId);
  }

  @RequirePermissions('SEGURIDAD', 'eliminar_seguridad')
  @Delete('roles/:id')
  async removeRol(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.seguridadService.removeRol(id, req.user.userId);
  }

  // --- MATRIZ DE PERMISOS ---
  @RequirePermissions('SEGURIDAD', 'ver_seguridad')
  @Get('matriz')
  async getMatriz() {
    return { success: true, data: await this.seguridadService.getMatrizModulos() };
  }

  @RequirePermissions('SEGURIDAD', 'ver_seguridad')
  @Get('roles/:idRol/permisos-ids')
  async getPermisosRol(@Param('idRol', ParseIntPipe) idRol: number) {
    return { success: true, data: await this.seguridadService.getPermisosIds(idRol) };
  }

  @RequirePermissions('SEGURIDAD', 'actualizar_seguridad')
  @Post('roles/:idRol/permisos')
  async updatePermisosRol(@Param('idRol', ParseIntPipe) idRol: number, @Body() body: { accionesIds: number[] }) {
    return this.seguridadService.updatePermisosRol(idRol, body.accionesIds);
  }
}
import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, ParseIntPipe, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { EmpresasService } from './empresas.service';
import {
  CreateEmpresaDto,
  UpdateEmpresaDto,
  GuardarCredencialesDto,
  CreateUsuarioPortalDto,
  UpdateUsuarioPortalDto,
  ResetPasswordUsuarioPortalDto,
  CambiarEstadoUsuarioPortalDto,
} from './dto/empresa.dto';

@Controller('vencimientos/empresas')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class EmpresasController {
  constructor(private readonly empresasService: EmpresasService) {}

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'crear_empresa')
  @Post()
  create(@Body() dto: CreateEmpresaDto, @Req() req: any) {
    return this.empresasService.create(dto, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_vencimiento_tributario')
  @Get()
  findAll(@Query('estado_cliente') estadoCliente?: string, @Query('search') search?: string) {
    return this.empresasService.findAll(estadoCliente, search);
  }

  // Ruta ESTÁTICA — va antes de `@Get(':id')` o el `ParseIntPipe` la recibe como ID y
  // responde 400 (la regla de orden de rutas de CLAUDE.md).
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_usuario_portal')
  @Get('roles-portal')
  rolesPortal() {
    return this.empresasService.rolesPortal();
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_vencimiento_tributario')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.empresasService.findOne(id);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'editar_empresa')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEmpresaDto, @Req() req: any) {
    return this.empresasService.update(id, dto, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'eliminar_empresa')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.empresasService.remove(id, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_credenciales_sunat')
  @Get(':id/credenciales')
  obtenerCredenciales(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.empresasService.obtenerCredenciales(id, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_credenciales_sunat')
  @Put(':id/credenciales')
  guardarCredenciales(@Param('id', ParseIntPipe) id: number, @Body() dto: GuardarCredencialesDto, @Req() req: any) {
    return this.empresasService.guardarCredenciales(id, dto, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_credenciales_sunat')
  @Post(':id/abrir-mis-declaraciones')
  abrirMisDeclaraciones(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.empresasService.abrirMisDeclaraciones(id, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_credenciales_sunat')
  @Post(':id/abrir-tramites-consultas')
  abrirTramitesConsultas(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.empresasService.abrirTramitesConsultas(id, req.user.userId);
  }

  // ── Cuentas del PORTAL CLIENTE de la empresa ──────────────────────────────
  //
  // Piden `*_usuario_portal` (módulo VENCIMIENTOS_TRIBUTARIO) y no los permisos de
  // USUARIOS: quien lleva las empresas cliente tiene que poder darle acceso al portal
  // a su contacto sin recibir de paso el alta de usuarios del ESTUDIO.
  //
  // La empresa sale SIEMPRE del `:id` de la URL. El body no la trae ni puede traerla
  // (no está en los DTOs), así que desde esta pantalla no hay forma de crear una cuenta
  // apuntando a otra empresa.

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_usuario_portal')
  @Get(':id/usuarios')
  listarUsuarios(@Param('id', ParseIntPipe) id: number) {
    return this.empresasService.listarUsuarios(id);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'crear_usuario_portal')
  @Post(':id/usuarios')
  crearUsuario(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateUsuarioPortalDto, @Req() req: any) {
    return this.empresasService.crearUsuario(id, dto, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'editar_usuario_portal')
  @Put(':id/usuarios/:idUsuario')
  actualizarUsuario(
    @Param('id', ParseIntPipe) id: number,
    @Param('idUsuario', ParseIntPipe) idUsuario: number,
    @Body() dto: UpdateUsuarioPortalDto,
    @Req() req: any,
  ) {
    return this.empresasService.actualizarUsuario(id, idUsuario, dto, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'editar_usuario_portal')
  @Put(':id/usuarios/:idUsuario/password')
  resetearPassword(
    @Param('id', ParseIntPipe) id: number,
    @Param('idUsuario', ParseIntPipe) idUsuario: number,
    @Body() dto: ResetPasswordUsuarioPortalDto,
    @Req() req: any,
  ) {
    return this.empresasService.resetearPasswordUsuario(id, idUsuario, dto.password, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'editar_usuario_portal')
  @Put(':id/usuarios/:idUsuario/estado')
  cambiarEstadoUsuario(
    @Param('id', ParseIntPipe) id: number,
    @Param('idUsuario', ParseIntPipe) idUsuario: number,
    @Body() dto: CambiarEstadoUsuarioPortalDto,
    @Req() req: any,
  ) {
    return this.empresasService.cambiarEstadoUsuario(id, idUsuario, dto.estado_registro, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'eliminar_usuario_portal')
  @Delete(':id/usuarios/:idUsuario')
  eliminarUsuario(
    @Param('id', ParseIntPipe) id: number,
    @Param('idUsuario', ParseIntPipe) idUsuario: number,
    @Req() req: any,
  ) {
    return this.empresasService.eliminarUsuario(id, idUsuario, req.user.userId);
  }
}

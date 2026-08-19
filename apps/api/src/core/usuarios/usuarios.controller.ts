import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, ParseIntPipe, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { UsuariosService } from './usuarios.service';
import { CreateUsuarioDto, UpdateUsuarioDto } from './dto/usuario.dto';
import { CambiarPasswordDto } from './dto/cambiar-password.dto';

@Controller('usuarios')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  @RequirePermissions('USUARIOS', 'ver_usuario')
  @Get('listas/roles')
  getRoles() {
    return this.usuariosService.getRoles();
  }

  // Sin @RequirePermissions: cualquier usuario logueado cambia su propia contraseña
  @Put('me/password')
  cambiarPassword(@Body() dto: CambiarPasswordDto, @Req() req: any) {
    return this.usuariosService.cambiarPassword(req.user.userId, dto);
  }

  @RequirePermissions('USUARIOS', 'crear_usuario')
  @Post()
  create(@Body() dto: CreateUsuarioDto, @Req() req: any) {
    return this.usuariosService.create(dto, req.user.userId);
  }

  @RequirePermissions('USUARIOS', 'ver_usuario')
  @Get()
  findAll() {
    return this.usuariosService.findAll();
  }

  @RequirePermissions('USUARIOS', 'ver_usuario')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usuariosService.findOne(id);
  }

  @RequirePermissions('USUARIOS', 'actualizar_usuario')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUsuarioDto, @Req() req: any) {
    return this.usuariosService.update(id, dto, req.user.userId);
  }

  @RequirePermissions('USUARIOS', 'eliminar_usuario')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.usuariosService.remove(id, req.user.userId);
  }
}
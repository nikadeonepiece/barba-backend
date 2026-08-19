import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, ParseIntPipe, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { EmpresasService } from './empresas.service';
import { CreateEmpresaDto, UpdateEmpresaDto, GuardarCredencialesDto } from './dto/empresa.dto';

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
}

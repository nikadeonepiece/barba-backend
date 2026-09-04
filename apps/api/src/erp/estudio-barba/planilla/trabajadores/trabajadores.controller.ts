import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, ParseIntPipe, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { TrabajadoresService } from './trabajadores.service';
import {
  CreateTrabajadorDto, UpdateTrabajadorDto, CesarTrabajadorDto,
  CreateRemuneracionDto, CreateConceptoFijoDto, UpdateEmpresaConfigDto,
} from './dto/trabajador.dto';

@Controller('planilla/trabajadores')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TrabajadoresController {
  constructor(private readonly service: TrabajadoresService) {}

  // --- Rutas estáticas primero: si ':id' fuera antes, capturaría 'empresas' ---
  @RequirePermissions('PLANILLA', 'ver_trabajador')
  @Get('empresas')
  findEmpresasConConfig() {
    return this.service.findEmpresasConConfig();
  }

  @RequirePermissions('PLANILLA', 'ver_trabajador')
  @Get('empresas/:idEmpresa/config')
  findEmpresaConfig(@Param('idEmpresa', ParseIntPipe) idEmpresa: number) {
    return this.service.findEmpresaConfig(idEmpresa);
  }

  // Usa la Clave SOL de la empresa: exige el mismo permiso sensible que el módulo
  // de empresas para verla o editarla, no basta con 'ver_trabajador'.
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_credenciales_sunat')
  @Post('empresas/:idEmpresa/abrir-tregistro')
  abrirTregistro(@Param('idEmpresa', ParseIntPipe) idEmpresa: number, @Req() req: any) {
    return this.service.abrirTregistro(idEmpresa, req.user.userId);
  }

  // Devuelve el padrón para revisión, NO crea trabajadores. El recorrido ya está
  // verificado (11/11 el 01/09/2026, ver guía TREG), pero la vista previa se queda:
  // lo que trae es la remuneración de INGRESO, no la de hoy, y eso lo tiene que
  // mirar una persona antes de que entre a la planilla.
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_credenciales_sunat')
  @Post('empresas/:idEmpresa/consultar-tregistro')
  consultarTregistro(
    @Param('idEmpresa', ParseIntPipe) idEmpresa: number,
    @Query('supervisado') supervisado: string,
    // Modo exploración: no lee el padrón, va a ver qué ofrece "Consultas y reportes".
    // No lo usa la pantalla; se dispara a mano mientras se decide el camino bueno.
    @Query('explorar') explorar: string,
    @Req() req: any,
  ) {
    return this.service.consultarTregistro(idEmpresa, supervisado !== 'false', req.user.userId, explorar === 'true');
  }

  @RequirePermissions('PLANILLA', 'editar_config_empresa_planilla')
  @Put('empresas/:idEmpresa/config')
  updateEmpresaConfig(@Param('idEmpresa', ParseIntPipe) idEmpresa: number, @Body() dto: UpdateEmpresaConfigDto, @Req() req: any) {
    return this.service.updateEmpresaConfig(idEmpresa, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'ver_trabajador')
  @Get()
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @RequirePermissions('PLANILLA', 'crear_trabajador')
  @Post()
  create(@Body() dto: CreateTrabajadorDto, @Req() req: any) {
    return this.service.create(dto, req.user.userId);
  }

  // --- Sub-recursos del trabajador ---
  @RequirePermissions('PLANILLA', 'ver_remuneracion')
  @Get(':id/remuneraciones')
  findRemuneraciones(@Param('id', ParseIntPipe) id: number) {
    return this.service.findRemuneraciones(id);
  }

  @RequirePermissions('PLANILLA', 'editar_remuneracion')
  @Post(':id/remuneraciones')
  createRemuneracion(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateRemuneracionDto, @Req() req: any) {
    return this.service.createRemuneracion(id, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'editar_remuneracion')
  @Delete(':id/remuneraciones/:idRem')
  removeRemuneracion(@Param('id', ParseIntPipe) id: number, @Param('idRem', ParseIntPipe) idRem: number, @Req() req: any) {
    return this.service.removeRemuneracion(id, idRem, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'ver_trabajador')
  @Get(':id/conceptos-fijos')
  findConceptosFijos(@Param('id', ParseIntPipe) id: number) {
    return this.service.findConceptosFijos(id);
  }

  @RequirePermissions('PLANILLA', 'editar_trabajador')
  @Post(':id/conceptos-fijos')
  createConceptoFijo(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateConceptoFijoDto, @Req() req: any) {
    return this.service.createConceptoFijo(id, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'editar_trabajador')
  @Delete(':id/conceptos-fijos/:idCf')
  removeConceptoFijo(@Param('id', ParseIntPipe) id: number, @Param('idCf', ParseIntPipe) idCf: number, @Req() req: any) {
    return this.service.removeConceptoFijo(id, idCf, req.user.userId);
  }

  // PATCH = acción puntual (cierre del vínculo laboral), no reemplazo del recurso.
  @RequirePermissions('PLANILLA', 'editar_trabajador')
  @Patch(':id/cesar')
  cesar(@Param('id', ParseIntPipe) id: number, @Body() dto: CesarTrabajadorDto, @Req() req: any) {
    return this.service.cesar(id, dto, req.user.userId);
  }

  // --- Dinámicas al final ---
  @RequirePermissions('PLANILLA', 'ver_trabajador')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @RequirePermissions('PLANILLA', 'editar_trabajador')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTrabajadorDto, @Req() req: any) {
    return this.service.update(id, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'eliminar_trabajador')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remove(id, req.user.userId);
  }
}

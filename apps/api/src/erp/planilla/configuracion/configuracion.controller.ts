import { Controller, Get, Post, Put, Delete, Body, Param, Query, ParseIntPipe, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { ConfiguracionService } from './configuracion.service';
import {
  UpdateRegimenDto, CreateAfpTasaDto, UpdateAfpTasaDto,
  CreateParametroDto, UpdateParametroDto, UpdateEscalaDto,
  UpdateBancoDto, CreateTareoMarcaDto, UpdateTareoMarcaDto,
} from './dto/configuracion.dto';

/**
 * Configuración de cálculo de planilla: lo que SUNAT no publica.
 *
 * Todas las rutas son estáticas con un `:id` al final por sub-recurso, así que no
 * hay riesgo de que una ruta dinámica capture un nombre (ver orden de rutas en
 * CLAUDE.md). Editar acá afecta el cálculo de TODAS las empresas, por eso el
 * permiso de escritura es uno solo y separado del de lectura.
 */
@Controller('planilla/configuracion')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ConfiguracionController {
  constructor(private readonly service: ConfiguracionService) {}

  @RequirePermissions('PLANILLA', 'ver_config_planilla')
  @Get('resumen')
  resumen() {
    return this.service.resumen();
  }

  // ---------- Regímenes laborales ----------
  @RequirePermissions('PLANILLA', 'ver_config_planilla')
  @Get('regimenes')
  findRegimenes() {
    return this.service.findRegimenes();
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Put('regimenes/:id')
  updateRegimen(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRegimenDto, @Req() req: any) {
    return this.service.updateRegimen(id, dto, req.user.userId);
  }

  // ---------- AFP ----------
  @RequirePermissions('PLANILLA', 'ver_config_planilla')
  @Get('afps')
  findAfps() {
    return this.service.findAfps();
  }

  @RequirePermissions('PLANILLA', 'ver_config_planilla')
  @Get('afp-tasas')
  findAfpTasas() {
    return this.service.findAfpTasas();
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Post('afp-tasas')
  createAfpTasa(@Body() dto: CreateAfpTasaDto, @Req() req: any) {
    return this.service.createAfpTasa(dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Put('afp-tasas/:id')
  updateAfpTasa(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateAfpTasaDto, @Req() req: any) {
    return this.service.updateAfpTasa(id, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Delete('afp-tasas/:id')
  removeAfpTasa(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.removeAfpTasa(id, req.user.userId);
  }

  // ---------- Parámetros laborales ----------
  @RequirePermissions('PLANILLA', 'ver_config_planilla')
  @Get('parametros')
  findParametros() {
    return this.service.findParametros();
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Post('parametros')
  createParametro(@Body() dto: CreateParametroDto, @Req() req: any) {
    return this.service.createParametro(dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Put('parametros/:id')
  updateParametro(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateParametroDto, @Req() req: any) {
    return this.service.updateParametro(id, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Delete('parametros/:id')
  removeParametro(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.removeParametro(id, req.user.userId);
  }

  // ---------- Escala de renta de quinta ----------
  @RequirePermissions('PLANILLA', 'ver_config_planilla')
  @Get('escala-renta')
  findEscala() {
    return this.service.findEscala();
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Put('escala-renta/:id')
  updateEscala(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEscalaDto, @Req() req: any) {
    return this.service.updateEscala(id, dto, req.user.userId);
  }

  // ---------- Bancos ----------
  @RequirePermissions('PLANILLA', 'ver_config_planilla')
  @Get('bancos')
  findBancos() {
    return this.service.findBancos();
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Put('bancos/:id')
  updateBanco(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBancoDto, @Req() req: any) {
    return this.service.updateBanco(id, dto, req.user.userId);
  }

  // ---------- Marcas del tareo ----------
  @RequirePermissions('PLANILLA', 'ver_config_planilla')
  @Get('tareo-marcas')
  findTareoMarcas() {
    return this.service.findTareoMarcas();
  }

  @RequirePermissions('PLANILLA', 'ver_config_planilla')
  @Get('tipos-suspension')
  findTiposSuspension() {
    return this.service.findTiposSuspension();
  }

  // ---------- Catálogos paramétricos de SUNAT (genérico) ----------
  // Alimenta los desplegables de cualquier formulario del módulo: tipo de documento
  // (3), tipo de contrato (12), motivo de cese (17), categoría ocupacional (24)...
  // Va con 'ver_trabajador' además de 'ver_config_planilla' porque el formulario del
  // padrón lo necesita y no tiene por qué exigir permisos de configuración.
  @RequirePermissions('PLANILLA', 'ver_trabajador')
  @Get('catalogo/:tablaNum')
  catalogoSunat(
    @Param('tablaNum', ParseIntPipe) tablaNum: number,
    @Query('incluirSectorPublico') incluirSectorPublico?: string,
  ) {
    return this.service.catalogoSunat(tablaNum, incluirSectorPublico === 'true');
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Post('tareo-marcas')
  createTareoMarca(@Body() dto: CreateTareoMarcaDto, @Req() req: any) {
    return this.service.createTareoMarca(dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Put('tareo-marcas/:id')
  updateTareoMarca(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTareoMarcaDto, @Req() req: any) {
    return this.service.updateTareoMarca(id, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'editar_config_planilla')
  @Delete('tareo-marcas/:id')
  removeTareoMarca(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.removeTareoMarca(id, req.user.userId);
  }
}

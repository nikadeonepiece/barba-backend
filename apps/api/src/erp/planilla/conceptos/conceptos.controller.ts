import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, ParseIntPipe, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { ConceptosService } from './conceptos.service';
import { CreateConceptoDto, UpdateConceptoDto, UpdateReglasConceptoDto } from './dto/concepto.dto';

@Controller('planilla/conceptos')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ConceptosController {
  constructor(private readonly service: ConceptosService) {}

  @RequirePermissions('PLANILLA', 'ver_concepto_plame')
  @Get()
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  // Rutas fijas ANTES de ':id', si no 'grupos' y 'version' entran por el ParseIntPipe.
  @RequirePermissions('PLANILLA', 'ver_concepto_plame')
  @Get('grupos')
  gruposDisponibles() {
    return this.service.gruposDisponibles();
  }

  @RequirePermissions('PLANILLA', 'ver_concepto_plame')
  @Get('version')
  versionVigente() {
    return this.service.versionVigente();
  }

  @RequirePermissions('PLANILLA', 'ver_concepto_plame')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @RequirePermissions('PLANILLA', 'crear_concepto_plame')
  @Post()
  create(@Body() dto: CreateConceptoDto, @Req() req: any) {
    return this.service.create(dto, req.user.userId);
  }

  // PATCH = cambio puntual de las reglas del estudio, sirve para CUALQUIER concepto.
  @RequirePermissions('PLANILLA', 'editar_concepto_plame')
  @Patch(':id/reglas')
  updateReglas(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateReglasConceptoDto, @Req() req: any) {
    return this.service.updateReglas(id, dto, req.user.userId);
  }

  // PUT = reemplazo completo, solo para conceptos propios del estudio.
  @RequirePermissions('PLANILLA', 'editar_concepto_plame')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateConceptoDto, @Req() req: any) {
    return this.service.update(id, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'eliminar_concepto_plame')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remove(id, req.user.userId);
  }
}

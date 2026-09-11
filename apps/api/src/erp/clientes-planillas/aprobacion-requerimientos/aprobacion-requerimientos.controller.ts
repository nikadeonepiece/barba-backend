import {
  Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { AprobacionRequerimientosService } from './aprobacion-requerimientos.service';
import { RequerimientosService } from '../requerimientos/requerimientos.service';
import {
  AprobarRequerimientoDto, RechazarRequerimientoDto, ListarRequerimientosQueryDto,
} from '../requerimientos/dto/requerimiento.dto';

/**
 * Bandeja de aprobación — la pantalla de FINANZAS.
 *
 * Módulo de permisos `APROBACION_REQUERIMIENTOS`, distinto del de la pantalla que
 * registra: con un solo módulo, dar de alta a quien carga los pedidos lo dejaría a un
 * checkbox de poder aprobarse los suyos.
 *
 * Los catálogos (proveedores, conceptos…) NO se repiten acá: esta pantalla llama a los
 * de `cliente/requerimientos`, que ya existen. Lo que sí se repite es el endpoint del
 * comprobante, porque los endpoints de allá exigen `ver_requerimiento` y quien aprueba
 * puede no tenerlo — un 403 al intentar mirar la proforma que tiene que aprobar.
 * (`conceptos.controller.ts` documenta el mismo caso al revés.)
 *
 * Orden de rutas: `resumen` (estática) antes de `:id`.
 */
@Controller('cliente/aprobacion-requerimientos')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AprobacionRequerimientosController {
  constructor(
    private readonly service: AprobacionRequerimientosService,
    private readonly requerimientosService: RequerimientosService,
  ) {}

  @RequirePermissions('APROBACION_REQUERIMIENTOS', 'ver_aprobacion_requerimiento')
  @Get('resumen')
  resumen(@Req() req: any, @Query('id_empresa') idEmpresa?: string) {
    return this.service.resumen(idEmpresa ? Number(idEmpresa) : undefined);
  }

  @RequirePermissions('APROBACION_REQUERIMIENTOS', 'ver_aprobacion_requerimiento')
  @Get()
  findAll(@Req() req: any, @Query() query: ListarRequerimientosQueryDto) {
    return this.service.findAll(query, req.user);
  }

  @RequirePermissions('APROBACION_REQUERIMIENTOS', 'ver_aprobacion_requerimiento')
  @Get(':id/comprobante')
  async verComprobante(@Param('id', ParseIntPipe) id: number, @Res() res: Response, @Req() req?: any) {
    await this.requerimientosService.verComprobante(id, res, req?.user);
  }

  @RequirePermissions('APROBACION_REQUERIMIENTOS', 'ver_aprobacion_requerimiento')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.findOne(id, req.user);
  }

  /**
   * `@Patch` y no `@Put`: no reemplaza el requerimiento, cambia su estado y —como
   * mucho— ajusta los montos de las líneas que ya existen.
   */
  @RequirePermissions('APROBACION_REQUERIMIENTOS', 'aprobar_requerimiento')
  @Patch(':id/aprobar')
  aprobar(@Param('id', ParseIntPipe) id: number, @Body() dto: AprobarRequerimientoDto, @Req() req: any) {
    return this.service.aprobar(id, dto, req.user.userId);
  }

  @RequirePermissions('APROBACION_REQUERIMIENTOS', 'rechazar_requerimiento')
  @Patch(':id/rechazar')
  rechazar(@Param('id', ParseIntPipe) id: number, @Body() dto: RechazarRequerimientoDto, @Req() req: any) {
    return this.service.rechazar(id, dto, req.user.userId);
  }

  @RequirePermissions('APROBACION_REQUERIMIENTOS', 'revertir_requerimiento')
  @Post(':id/revertir')
  revertir(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.revertir(id, req.user.userId);
  }
}

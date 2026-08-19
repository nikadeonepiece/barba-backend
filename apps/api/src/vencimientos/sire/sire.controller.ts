import { Controller, Get, Post, Patch, Body, Query, Param, ParseIntPipe, UseGuards, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { SireService } from './sire.service';
import { GenerarDescargaSireDto } from './sire.dto';

@Controller('vencimientos/sire')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SireController {
  constructor(private readonly service: SireService) {}

  @Post('probar-conexion')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'usar_sire')
  probarConexion(@Body('id_empresa', ParseIntPipe) idEmpresa: number) {
    return this.service.probarConexion(idEmpresa);
  }

  // --- Historial de descargas RVIE/RCE (flujo con ticket), por empresa cliente ---

  @Get('descargas')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_sire_descarga')
  findAll(@Query('id_empresa', ParseIntPipe) idEmpresa: number, @Query() query: any) {
    return this.service.findAll(idEmpresa, query);
  }

  @Post('descargas')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'generar_sire_descarga')
  generarTicket(@Body() dto: GenerarDescargaSireDto, @Req() req: any) {
    return this.service.generarTicket(dto, req.user.userId);
  }

  @Patch('descargas/:id/estado')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'generar_sire_descarga')
  consultarEstado(@Param('id', ParseIntPipe) id: number, @Query('id_empresa', ParseIntPipe) idEmpresa: number) {
    return this.service.consultarEstado(idEmpresa, id);
  }

  @Post('descargas/:id/traer-archivo')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'generar_sire_descarga')
  traerArchivo(@Param('id', ParseIntPipe) id: number, @Query('id_empresa', ParseIntPipe) idEmpresa: number, @Req() req: any) {
    return this.service.traerArchivo(idEmpresa, id, req.user.userId);
  }

  @Get('descargas/:id/archivo')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_sire_descarga')
  async descargarArchivo(@Param('id', ParseIntPipe) id: number, @Query('id_empresa', ParseIntPipe) idEmpresa: number, @Res() res: Response) {
    await this.service.descargarArchivoGuardado(idEmpresa, id, res);
  }

  @Get('descargas/:id/detalle')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_sire_descarga')
  verDetalle(@Param('id', ParseIntPipe) id: number, @Query('id_empresa', ParseIntPipe) idEmpresa: number, @Query() query: any) {
    return this.service.verDetalle(idEmpresa, id, query);
  }
}

import { Controller, Get, Post, Patch, Body, Query, Param, ParseIntPipe, UseGuards, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { SireService } from './sire.service';
import { GenerarDescargaSireDto, SincronizarItemsSireDto } from './sire.dto';

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

  // Grilla unificada SIRE + PLE. Va acá y no en PleController porque lee las dos tablas
  // y es lo que alimenta la pantalla de vencimientos/sire.
  //
  // Pide `ver_sire_descarga` y no un permiso combinado porque `PermissionsGuard` evalúa
  // UNA sola acción por endpoint (ver require-permissions.decorator.ts) — no hay forma
  // de exigir las dos acá. La consecuencia es deliberada y acotada: quien pueda ver la
  // pantalla ve también las FILAS de PLE (periodo, libro, si fue fuera de plazo), pero
  // bajar la constancia sigue exigiendo `ver_ple_presentado` en su propio endpoint.
  @Get('libros')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_sire_descarga')
  findAllLibros(@Query('id_empresa', ParseIntPipe) idEmpresa: number, @Query() query: any) {
    return this.service.findAllLibros(idEmpresa, query);
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

  // Baja de SUNAT el detalle de ítems (producto/cantidad/precio) de los comprobantes
  // emitidos del período. Es lento — abre un navegador y descarga un XML por
  // comprobante — así que va por su propio endpoint y no dentro de `verDetalle`.
  @Post('descargas/sincronizar-items')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'sincronizar_sire_items')
  sincronizarItems(@Body() dto: SincronizarItemsSireDto, @Req() req: any) {
    return this.service.sincronizarItemsVentas(dto.id_empresa, dto.periodo, req.user.userId);
  }

  @Get('descargas/:id/detalle')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_sire_descarga')
  verDetalle(@Param('id', ParseIntPipe) id: number, @Query('id_empresa', ParseIntPipe) idEmpresa: number, @Query() query: any) {
    return this.service.verDetalle(idEmpresa, id, query);
  }
}

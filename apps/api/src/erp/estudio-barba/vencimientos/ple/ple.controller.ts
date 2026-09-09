import { Controller, Get, Post, Body, Query, Param, ParseIntPipe, UseGuards, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { PleService } from './ple.service';
import { SincronizarPleDto } from './ple.dto';

@Controller('vencimientos/ple')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PleController {
  constructor(private readonly service: PleService) {}

  @Get('libros')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_ple_presentado')
  findAll(@Query('id_empresa', ParseIntPipe) idEmpresa: number, @Query() query: any) {
    return this.service.findAll(idEmpresa, query);
  }

  // Abre una sesión de navegador contra SUNAT y barre año por año: puede tardar varios
  // minutos en un historial completo. El frontend tiene que mostrar estado de carga y
  // NO encadenar empresas desde un mismo request.
  @Post('sincronizar')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'sincronizar_ple')
  sincronizar(@Body() dto: SincronizarPleDto, @Req() req: any) {
    return this.service.sincronizar(dto, req.user.userId);
  }

  @Get('libros/:id/constancia')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_ple_presentado')
  async descargarConstancia(
    @Param('id', ParseIntPipe) id: number,
    @Query('id_empresa', ParseIntPipe) idEmpresa: number,
    @Req() req: any,
    @Res() res: Response,
  ) {
    await this.service.descargarConstancia(idEmpresa, id, res, req.user.userId);
  }
}

import { Controller, Get, Post, Body, Query, UseGuards, ParseIntPipe, Req, Res, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { DeclaracionesService } from './declaraciones.service';
import {
  MarcarDeclaracionDto,
  UpsertCronogramaDto,
  RegistrarSaldoFavorDto,
  RegistrarCortePreliminarDto,
} from './dto/declaracion.dto';

const TIPOS_TRIBUTARIO = ['IGV_RENTA', 'RCE_RVIE_SIRE'];
// AFP_NET va con lo laboral (misma área que la planilla). Solo se marca A MANO:
// AFPnet no es SUNAT, así que la verificación automática de Fase 2 no lo cubre —
// ver la lista aparte en sunat-sync.controller.ts, que sigue siendo solo PLANILLA.
const TIPOS_LABORAL = ['PLANILLA', 'AFP_NET'];

@Controller('vencimientos')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DeclaracionesController {
  constructor(private readonly declaracionesService: DeclaracionesService) {}

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_vencimiento_tributario')
  @Get('semaforo')
  semaforo(@Query('anio', ParseIntPipe) anio: number, @Query('mes', ParseIntPipe) mes: number) {
    return this.declaracionesService.semaforo(anio, mes, TIPOS_TRIBUTARIO);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'marcar_declaracion')
  @Post('declaraciones/marcar-manual')
  marcarManual(@Body() dto: MarcarDeclaracionDto, @Req() req: any) {
    if (!TIPOS_TRIBUTARIO.includes(dto.tipo_obligacion)) {
      throw new BadRequestException('Este endpoint solo admite obligaciones tributarias (IGV_RENTA, RCE_RVIE_SIRE)');
    }
    return this.declaracionesService.marcarManual(dto, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_LABORAL', 'ver_vencimiento_laboral')
  @Get('laboral/semaforo')
  semaforoLaboral(@Query('anio', ParseIntPipe) anio: number, @Query('mes', ParseIntPipe) mes: number) {
    return this.declaracionesService.semaforo(anio, mes, TIPOS_LABORAL);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'exportar_pdf_vencimientos')
  @Get('semaforo/pdf')
  async semaforoPdf(
    @Query('anio', ParseIntPipe) anio: number,
    @Query('mes', ParseIntPipe) mes: number,
    @Query('id_empresa') idEmpresa: string | undefined,
    @Query('estado_semaforo') estadoSemaforo: string | undefined,
    @Res() res: Response,
  ) {
    await this.declaracionesService.semaforoPdf(
      anio, mes, TIPOS_TRIBUTARIO,
      { idEmpresa: idEmpresa ? Number(idEmpresa) : undefined, estadoSemaforo: estadoSemaforo || undefined },
      'Tributario', res,
    );
  }

  @RequirePermissions('VENCIMIENTOS_LABORAL', 'exportar_pdf_vencimientos_laboral')
  @Get('laboral/semaforo/pdf')
  async semaforoPdfLaboral(
    @Query('anio', ParseIntPipe) anio: number,
    @Query('mes', ParseIntPipe) mes: number,
    @Query('id_empresa') idEmpresa: string | undefined,
    @Query('estado_semaforo') estadoSemaforo: string | undefined,
    @Res() res: Response,
  ) {
    await this.declaracionesService.semaforoPdf(
      anio, mes, TIPOS_LABORAL,
      { idEmpresa: idEmpresa ? Number(idEmpresa) : undefined, estadoSemaforo: estadoSemaforo || undefined },
      'Laboral', res,
    );
  }

  @RequirePermissions('VENCIMIENTOS_LABORAL', 'marcar_declaracion_laboral')
  @Post('laboral/declaraciones/marcar-manual')
  marcarManualLaboral(@Body() dto: MarcarDeclaracionDto, @Req() req: any) {
    if (!TIPOS_LABORAL.includes(dto.tipo_obligacion)) {
      throw new BadRequestException('Este endpoint solo admite la obligación PLANILLA');
    }
    return this.declaracionesService.marcarManual(dto, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'editar_cronograma')
  @Post('cronograma')
  upsertCronograma(@Body() dto: UpsertCronogramaDto, @Req() req: any) {
    return this.declaracionesService.upsertCronograma(dto, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_vencimiento_tributario')
  @Get('cronograma')
  listarCronograma(@Query('anio') anio?: string, @Query('mes') mes?: string) {
    return this.declaracionesService.listarCronograma(anio ? Number(anio) : undefined, mes ? Number(mes) : undefined);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_saldo_favor')
  @Get('saldo-favor')
  saldoFavorPorEmpresa(@Query('id_empresa', ParseIntPipe) idEmpresa: number) {
    return this.declaracionesService.saldoFavorPorEmpresa(idEmpresa);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_saldo_favor')
  @Get('credito-fiscal-sire')
  creditoFiscalSirePorEmpresa(@Query('id_empresa', ParseIntPipe) idEmpresa: number) {
    return this.declaracionesService.creditoFiscalSirePorEmpresa(idEmpresa);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_saldo_favor')
  @Post('saldo-favor')
  registrarSaldoFavor(@Body() dto: RegistrarSaldoFavorDto, @Req() req: any) {
    return this.declaracionesService.registrarSaldoFavor(dto, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'editar_corte_preliminar')
  @Post('corte-preliminar')
  registrarCortePreliminar(@Body() dto: RegistrarCortePreliminarDto, @Req() req: any) {
    return this.declaracionesService.registrarCortePreliminar(dto, req.user.userId);
  }
}

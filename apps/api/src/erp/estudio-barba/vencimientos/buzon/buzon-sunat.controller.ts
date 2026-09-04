import { Controller, Get, Post, Patch, Body, Param, Query, ParseIntPipe, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { BuzonSunatService } from './buzon-sunat.service';
import { SincronizarBuzonSunatDto, GestionarNotificacionBuzonDto } from './buzon.dto';

/**
 * Buzón Electrónico de SUNAT — alcance de esta fase: listar y guardar en BD.
 * Los permisos van sobre VENCIMIENTOS_TRIBUTARIO (el buzón SOL notifica actos
 * tributarios), a diferencia de la casilla SUNAFIL que va sobre el módulo laboral.
 */
@Controller('vencimientos/buzon-sunat')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BuzonSunatController {
  constructor(private readonly service: BuzonSunatService) {}

  // Estáticas primero (Nest resuelve por orden de declaración): 'resumen' antes de
  // cualquier ':id', o un día una ruta dinámica se la comería como parámetro.
  @Get('resumen')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_buzon_sunat')
  resumen(@Query('id_empresa', ParseIntPipe) idEmpresa: number) {
    return this.service.resumen(idEmpresa);
  }

  @Get('notificaciones')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_buzon_sunat')
  listar(@Query('id_empresa', ParseIntPipe) idEmpresa: number, @Query() query: any) {
    return this.service.listarNotificaciones(idEmpresa, query);
  }

  @Get('notificaciones/:id')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_buzon_sunat')
  ver(@Param('id', ParseIntPipe) id: number, @Query('id_empresa', ParseIntPipe) idEmpresa: number) {
    return this.service.verNotificacion(idEmpresa, id);
  }

  @Patch('notificaciones/:id/gestion')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'gestionar_buzon_sunat')
  gestionar(
    @Param('id', ParseIntPipe) id: number,
    @Query('id_empresa', ParseIntPipe) idEmpresa: number,
    @Body() dto: GestionarNotificacionBuzonDto,
    @Req() req: any,
  ) {
    return this.service.gestionarNotificacion(idEmpresa, id, dto, req.user.userId);
  }

  // Botón "Sincronizar buzón" de una empresa: abre una sola sesión contra SUNAT.
  @Post('sincronizar')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'sincronizar_buzon_sunat')
  sincronizar(@Body() dto: SincronizarBuzonSunatDto, @Req() req: any) {
    return this.service.sincronizarEmpresa(dto.id_empresa, req.user.userId);
  }

  /**
   * Recorrido completo de las ~170 empresas. A propósito NO está atado a un @Cron:
   * cada empresa abre su propio navegador contra SUNAT y el WAF ya cortó conexiones
   * antes por insistir (ver sunat-scraping.client.ts). Se dispara a mano, o desde un
   * cron EXTERNO a lo sumo una vez al día, cuando el flujo esté verificado en vivo.
   */
  @Post('sincronizar-todas')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'sincronizar_buzon_sunat')
  sincronizarTodas(@Req() req: any) {
    return this.service.sincronizarTodas(req.user.userId);
  }

  @Get('sincronizaciones')
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_buzon_sunat')
  historial(@Query('id_empresa', ParseIntPipe) idEmpresa: number, @Query() query: any) {
    return this.service.listarSincronizaciones(idEmpresa, query);
  }
}

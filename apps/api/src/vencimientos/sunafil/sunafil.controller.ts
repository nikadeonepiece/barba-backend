import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { SunafilService } from './sunafil.service';
import { GestionarNotificacionSunafilDto, SincronizarCasillaSunafilDto } from './sunafil.dto';

/**
 * Casilla electrónica de SUNAFIL, por empresa cliente. Los permisos cuelgan del
 * módulo VENCIMIENTOS_LABORAL (SUNAFIL es fiscalización laboral, no tributaria).
 *
 * Todo endpoint exige `id_empresa` y el service filtra por él en el WHERE — sin
 * eso, cambiar un id en la URL dejaría ver notificaciones de otra empresa (IDOR).
 *
 * Orden de rutas: primero las estáticas (`resumen`, `sincronizaciones`,
 * `sincronizar`), después las dinámicas `:id` — si no, `/notificaciones/:id`
 * capturaría `resumen` como si fuera un ID.
 */
@Controller('vencimientos/sunafil')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SunafilController {
  constructor(private readonly service: SunafilService) {}

  @Get('resumen')
  @RequirePermissions('VENCIMIENTOS_LABORAL', 'ver_casilla_sunafil')
  resumen(@Query('id_empresa', ParseIntPipe) idEmpresa: number) {
    return this.service.resumen(idEmpresa);
  }

  @Get('sincronizaciones')
  @RequirePermissions('VENCIMIENTOS_LABORAL', 'ver_casilla_sunafil')
  historial(@Query('id_empresa', ParseIntPipe) idEmpresa: number, @Query() query: any) {
    return this.service.historialSincronizaciones(idEmpresa, query);
  }

  @Get('notificaciones')
  @RequirePermissions('VENCIMIENTOS_LABORAL', 'ver_casilla_sunafil')
  findAll(@Query('id_empresa', ParseIntPipe) idEmpresa: number, @Query() query: any) {
    return this.service.findAll(idEmpresa, query);
  }

  // Lee el portal real de SUNAFIL con Playwright — es lento (abre un navegador y
  // pasa por el OAuth2 de SUNAT), por eso es un POST explícito y no algo que
  // dispare el simple hecho de entrar a la pantalla.
  @Post('sincronizar')
  @RequirePermissions('VENCIMIENTOS_LABORAL', 'sincronizar_casilla_sunafil')
  sincronizar(@Body() dto: SincronizarCasillaSunafilDto, @Req() req: any) {
    return this.service.sincronizar(dto.id_empresa, req.user.userId);
  }

  @Get('notificaciones/:id')
  @RequirePermissions('VENCIMIENTOS_LABORAL', 'ver_casilla_sunafil')
  findOne(@Param('id', ParseIntPipe) id: number, @Query('id_empresa', ParseIntPipe) idEmpresa: number) {
    return this.service.obtenerNotificacion(idEmpresa, id);
  }

  @Patch('notificaciones/:id/gestion')
  @RequirePermissions('VENCIMIENTOS_LABORAL', 'gestionar_casilla_sunafil')
  gestionar(
    @Param('id', ParseIntPipe) id: number,
    @Query('id_empresa', ParseIntPipe) idEmpresa: number,
    @Body() dto: GestionarNotificacionSunafilDto,
    @Req() req: any,
  ) {
    return this.service.gestionar(idEmpresa, id, dto, req.user.userId);
  }
}

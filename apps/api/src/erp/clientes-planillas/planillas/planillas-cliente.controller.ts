import { Controller, Get, Param, ParseIntPipe, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { PlanillasClienteService } from './planillas-cliente.service';

/**
 * Planillas — PORTAL CLIENTE. Solo lectura y solo periodos CERRADOS (el motivo está en
 * `ESTADOS_VISIBLES`, en el service).
 *
 * Módulo de permisos `PLANILLAS_CLIENTE`, NO `PLANILLA`. Si reusara `ver_planilla`,
 * darle acceso al cliente lo dejaría a un checkbox mal marcado de poder calcular,
 * cerrar o anular una planilla — son acciones del mismo módulo.
 *
 * Orden de rutas: estáticas (`anios`, la raíz) antes que `:id`, y dentro de `:id` las
 * de más segmentos primero.
 */
@Controller('cliente/planillas')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PlanillasClienteController {
  constructor(private readonly service: PlanillasClienteService) {}

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_planilla_cliente')
  @Get('anios')
  anios(@Req() req: any) {
    return this.service.anios(req.user);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_planilla_cliente')
  @Get()
  findAll(@Req() req: any, @Query() query: any) {
    return this.service.findAll(req.user, query);
  }

  /**
   * `@Res()` SIN `passthrough`: deshabilita el TransformInterceptor, que si no
   * envolvería el binario del PDF dentro del JSON `{ success, data }` y la descarga
   * llegaría corrupta.
   */
  @RequirePermissions('PLANILLAS_CLIENTE', 'descargar_boleta_cliente')
  @Get(':id/boleta/:idTrabajador/pdf')
  async exportarBoletaPdf(
    @Param('id', ParseIntPipe) id: number,
    @Param('idTrabajador', ParseIntPipe) idTrabajador: number,
    @Req() req: any,
    @Res() res: Response,
  ) {
    await this.service.exportarBoletaPdf(req.user, id, idTrabajador, res);
  }

  // La boleta en JSON es la que alimenta la vista previa en pantalla. Pide
  // `ver_planilla_cliente` y no `descargar_boleta_cliente`: mirar no es descargar, y
  // así el estudio puede dejar a un cliente consultar sin habilitarle el PDF.
  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_planilla_cliente')
  @Get(':id/boleta/:idTrabajador')
  findBoleta(
    @Param('id', ParseIntPipe) id: number,
    @Param('idTrabajador', ParseIntPipe) idTrabajador: number,
    @Req() req: any,
  ) {
    return this.service.findBoleta(req.user, id, idTrabajador);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_planilla_cliente')
  @Get(':id/trabajadores')
  findTrabajadores(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.findTrabajadores(req.user, id);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_planilla_cliente')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.findOne(req.user, id);
  }
}

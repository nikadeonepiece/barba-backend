import { Controller, Get, Param, ParseIntPipe, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { PersonalClienteService } from './personal.service';

/**
 * Personal — PORTAL CLIENTE. Solo lectura: no hay un solo POST/PUT/DELETE, y eso es
 * deliberado. Quien da de alta trabajadores y carga contratos es el estudio.
 *
 * Todos los métodos pasan `req.user` al service, que resuelve la empresa desde el
 * token. El controller NUNCA lee un `id_empresa` del query ni del body: si lo hiciera,
 * bastaría cambiar un número en la URL para ver el personal de otra empresa.
 *
 * Orden de rutas: estáticas (`mi-empresa`, `areas`, `contratos/...`) ANTES de las
 * dinámicas. Con `@Get(':id')` primero, `mi-empresa` entraría como id y el
 * `ParseIntPipe` respondería 400.
 */
@Controller('cliente/personal')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PersonalClienteController {
  constructor(private readonly service: PersonalClienteService) {}

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_personal_cliente')
  @Get('mi-empresa')
  miEmpresa(@Req() req: any) {
    return this.service.miEmpresa(req.user);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_personal_cliente')
  @Get('areas')
  areas(@Req() req: any) {
    return this.service.areas(req.user);
  }

  /**
   * `@Res()` SIN `passthrough`: con `passthrough: true` el TransformInterceptor
   * seguiría envolviendo la respuesta y el PDF llegaría dentro de un JSON.
   */
  @RequirePermissions('PLANILLAS_CLIENTE', 'descargar_contrato_cliente')
  @Get('contratos/:idContrato/archivo')
  async descargarContrato(
    @Param('idContrato', ParseIntPipe) idContrato: number,
    @Req() req: any,
    @Res() res: Response,
  ) {
    await this.service.descargarContrato(req.user, idContrato, res);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_personal_cliente')
  @Get()
  findAll(@Req() req: any, @Query() query: any) {
    return this.service.findAll(req.user, query);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_personal_cliente')
  @Get(':id/contratos')
  findContratos(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.findContratos(req.user, id);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_personal_cliente')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.findOne(req.user, id);
  }
}

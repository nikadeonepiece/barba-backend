import { Controller, Get, Param, ParseIntPipe, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { SireClienteService } from './sire-cliente.service';

/**
 * SIRE — PORTAL CLIENTE. Solo lectura, y solo de los periodos que el estudio ya bajó
 * de SUNAT (el motivo está en `CONDICION_VISIBLE`, en el service).
 *
 * ── Por qué módulo de permisos propio (`SIRE_CLIENTE`) ──
 *
 * No es `VENCIMIENTOS_TRIBUTARIO`: ese módulo es del estudio y sus acciones
 * (`usar_sire`, `generar_sire_descarga`) operan sobre las ~170 empresas. Darle a un
 * cliente cualquier acción de ahí lo dejaría a un checkbox mal marcado de poder pedir
 * tickets a SUNAT por cuenta de otro.
 *
 * Tampoco es `PLANILLAS_CLIENTE`: el registro de ventas y compras no es planilla, y
 * hay clientes que llevan contabilidad con el estudio pero no planilla (y al revés).
 * Es la misma razón por la que la caja del portal tiene módulo propio.
 *
 * Ningún método lee `id_empresa` del query ni del body: el service lo resuelve desde
 * el token con `resolverEmpresaDelUsuario()`.
 *
 * Orden de rutas: estáticas (`anios`, la raíz) antes que `:id`, y dentro de `:id` las
 * de más segmentos primero.
 */
@Controller('cliente/sire')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SireClienteController {
  constructor(private readonly service: SireClienteService) {}

  @RequirePermissions('SIRE_CLIENTE', 'ver_sire_cliente')
  @Get('anios')
  anios(@Req() req: any) {
    return this.service.anios(req.user);
  }

  @RequirePermissions('SIRE_CLIENTE', 'ver_sire_cliente')
  @Get()
  findAll(@Req() req: any, @Query() query: any) {
    return this.service.findAll(req.user, query);
  }

  /**
   * `@Res()` SIN `passthrough`: deshabilita el TransformInterceptor, que si no
   * envolvería el binario del ZIP dentro del JSON `{ success, data }` y el archivo
   * llegaría corrupto.
   */
  @RequirePermissions('SIRE_CLIENTE', 'descargar_sire_cliente')
  @Get(':id/archivo')
  async descargarArchivo(@Param('id', ParseIntPipe) id: number, @Req() req: any, @Res() res: Response) {
    await this.service.descargarArchivo(req.user, id, res);
  }

  // La grilla pide `ver_sire_cliente` y no `descargar_sire_cliente`: mirar los
  // comprobantes en pantalla no es llevarse el archivo, y así el estudio puede dejar a
  // un cliente consultar sin habilitarle la descarga del ZIP original.
  @RequirePermissions('SIRE_CLIENTE', 'ver_sire_cliente')
  @Get(':id/detalle')
  verDetalle(@Param('id', ParseIntPipe) id: number, @Req() req: any, @Query() query: any) {
    return this.service.verDetalle(req.user, id, query);
  }
}

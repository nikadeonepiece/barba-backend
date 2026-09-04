import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { ModalidadPagoClienteService } from './modalidad-pago.service';
import { CambiarModalidadPagoDto } from './dto/modalidad-pago.dto';

/**
 * Forma de cobro — PORTAL CLIENTE.
 *
 * `@Patch` y no `@Put`: es un cambio puntual de UNA columna del trabajador, no el
 * reemplazo de su ficha. Un `PUT` acá insinuaría que el portal manda el registro
 * completo, que es justo lo que no puede hacer — el sueldo, el régimen y las cuentas
 * bancarias las administra el estudio.
 *
 * Orden de rutas: `areas` (estática) va ANTES de `:idTrabajador`. Con la dinámica
 * primero, `areas` entraría como id y el `ParseIntPipe` respondería 400.
 */
@Controller('cliente/modalidad-pago')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ModalidadPagoClienteController {
  constructor(private readonly service: ModalidadPagoClienteService) {}

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_modalidad_pago_cliente')
  @Get('areas')
  areas(@Req() req: any) {
    return this.service.areas(req.user);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_modalidad_pago_cliente')
  @Get()
  findAll(@Req() req: any, @Query() query: any) {
    return this.service.findAll(req.user, query);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'editar_modalidad_pago_cliente')
  @Patch(':idTrabajador')
  cambiar(
    @Param('idTrabajador', ParseIntPipe) idTrabajador: number,
    @Body() dto: CambiarModalidadPagoDto,
    @Req() req: any,
  ) {
    return this.service.cambiar(req.user, idTrabajador, dto, req.user.userId);
  }
}

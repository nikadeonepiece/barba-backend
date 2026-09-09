import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { TableroClienteService } from './tablero-cliente.service';

/**
 * Tableros — PORTAL CLIENTE. Solo lectura: no hay un solo POST/PUT/DELETE, y no puede
 * haberlo. Un tablero muestra lo que ya cargaron las otras pantallas.
 *
 * ── Dos permisos en un mismo controller, y de MÓDULOS distintos ──
 *
 * `GET /` pide `PLANILLAS_CLIENTE` y `GET /caja` pide `CAJAS_CLIENTE`, porque cada
 * tablero muestra los datos de ese módulo y nada más. Es la misma razón por la que la
 * caja del portal tiene módulo propio (ver sección 10 de `bd.sql`): una empresa que solo
 * usa la caja chica no tiene por qué recibir permisos de planilla para ver su tablero, y
 * al revés. Si mañana el tablero de planilla mostrara un número de la caja, ese número
 * se va a otro endpoint — no se relaja el permiso de este.
 *
 * Todos los métodos pasan `req.user` al service, que resuelve la empresa desde el token.
 * El controller NUNCA lee un `id_empresa` del query: si lo hiciera, bastaría cambiar un
 * número en la URL para ver la foto de otra empresa.
 *
 * Orden de rutas: la estática `caja` va antes que cualquier dinámica. Hoy no hay
 * ninguna `:id`, pero el orden se respeta igual para que agregar una no rompa nada.
 */
@Controller('cliente/tablero')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TableroClienteController {
  constructor(private readonly service: TableroClienteService) {}

  @RequirePermissions('CAJAS_CLIENTE', 'ver_tablero_caja_cliente')
  @Get('caja')
  caja(@Req() req: any, @Query() query: any) {
    return this.service.resumenCaja(req.user, query);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_tablero_cliente')
  @Get()
  resumen(@Req() req: any, @Query() query: any) {
    return this.service.resumen(req.user, query);
  }
}

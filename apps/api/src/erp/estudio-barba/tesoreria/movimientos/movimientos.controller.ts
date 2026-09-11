import {
  Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { MovimientosService } from './movimientos.service';
import { CONFIG_SUBIDA_COMPROBANTE_REQ } from '../../../clientes-planillas/requerimientos/requerimientos-archivo.service';
import {
  CreateMovimientoDto, UpdateMovimientoDto, TransferenciaDto, AnularMovimientoDto,
  CambiarEstadoFlujoDto, ListarMovimientosQueryDto,
} from './dto/movimiento.dto';

/**
 * Movimientos de tesorería — el libro de plata de las cuentas bancarias.
 *
 * Permisos del módulo `TESORERIA`, que ya existía: `ver_movimientos`,
 * `crear_movimiento`, `editar_movimiento`, `anular_movimiento`,
 * `transferir_movimiento` y `conciliar_movimiento`.
 *
 * Orden de rutas: estáticas (`buscar/*`, `catalogos`, `transferencia`, `exportar/*`)
 * ANTES de las dinámicas `:id`. Con `:id` primero, NestJS tomaría 'catalogos' como id
 * y el `ParseIntPipe` respondería 400.
 */
@Controller('tesoreria/movimientos')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MovimientosController {
  constructor(private readonly service: MovimientosService) {}

  // ── CATÁLOGOS ───────────────────────────────────────────────────────────────

  @RequirePermissions('TESORERIA', 'ver_movimientos')
  @Get('catalogos')
  getCatalogos() {
    return this.service.getCatalogos();
  }

  @RequirePermissions('TESORERIA', 'ver_movimientos')
  @Get('buscar/empresas')
  buscarEmpresas(@Query('search') search = '', @Query('id') id?: string) {
    return this.service.buscarEmpresas(search, id ? Number(id) : undefined);
  }

  @RequirePermissions('TESORERIA', 'ver_movimientos')
  @Get('buscar/cuentas')
  buscarCuentas(@Query('search') search = '', @Query('id_empresa') idEmpresa?: string, @Query('id') id?: string) {
    return this.service.buscarCuentas(search, idEmpresa ? Number(idEmpresa) : undefined, id ? Number(id) : undefined);
  }

  @RequirePermissions('TESORERIA', 'ver_movimientos')
  @Get('buscar/terceros')
  buscarTerceros(@Query('search') search = '', @Query('id_empresa') idEmpresa?: string, @Query('id') id?: string) {
    return this.service.buscarTerceros(search, idEmpresa ? Number(idEmpresa) : undefined, id ? Number(id) : undefined);
  }

  @RequirePermissions('TESORERIA', 'ver_movimientos')
  @Get('buscar/conceptos')
  buscarConceptos(@Query('search') search = '', @Query('id_empresa') idEmpresa?: string, @Query('id') id?: string) {
    return this.service.buscarConceptos(search, idEmpresa ? Number(idEmpresa) : undefined, id ? Number(id) : undefined);
  }

  // ── EXPORTACIÓN ─────────────────────────────────────────────────────────────
  // `@Res()` desactiva el TransformInterceptor: el service escribe el archivo.

  @RequirePermissions('TESORERIA', 'exportar_excel_tesoreria')
  @Get('exportar/excel')
  async exportarExcel(@Query() query: any, @Res() res: Response) {
    await this.service.exportarExcel(query, res);
  }

  @RequirePermissions('TESORERIA', 'exportar_excel_tesoreria')
  @Get('exportar/pdf')
  async exportarPdf(@Query() query: any, @Res() res: Response) {
    await this.service.exportarPdf(query, res);
  }

  // ── TRANSFERENCIA ───────────────────────────────────────────────────────────
  // Ruta propia y no un `POST /` con dos cuentas: el resultado son DOS movimientos
  // atados, y el permiso también es distinto.

  @RequirePermissions('TESORERIA', 'transferir_movimiento')
  @Post('transferencia')
  transferir(@Body() dto: TransferenciaDto, @Req() req: any) {
    return this.service.transferir(dto, req.user.userId);
  }

  // ── LISTADO Y DETALLE ───────────────────────────────────────────────────────

  @RequirePermissions('TESORERIA', 'ver_movimientos')
  @Get()
  findAll(@Query() query: ListarMovimientosQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('TESORERIA', 'crear_movimiento')
  @Post()
  create(@Body() dto: CreateMovimientoDto, @Req() req: any) {
    return this.service.create(dto, req.user.userId);
  }

  // `:id/comprobante` no choca con `:id` porque tiene un segmento más.
  @RequirePermissions('TESORERIA', 'ver_movimientos')
  @Get(':id/comprobante')
  async verComprobante(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    await this.service.verComprobante(id, res);
  }

  /**
   * La subida va aparte del guardado: el formulario manda JSON y el archivo viaja como
   * multipart. Mezclarlos obligaría a parsear el cuerpo a mano y perder la validación
   * del DTO.
   */
  @RequirePermissions('TESORERIA', 'editar_movimiento')
  @Post(':id/comprobante')
  @UseInterceptors(FileInterceptor('archivo', CONFIG_SUBIDA_COMPROBANTE_REQ))
  subirComprobante(@Param('id', ParseIntPipe) id: number, @UploadedFile() archivo: any, @Req() req: any) {
    return this.service.guardarComprobante(id, archivo, req.user.userId);
  }

  /** `@Patch` y no `@Put`: cambia UN campo, no reemplaza el movimiento. */
  @RequirePermissions('TESORERIA', 'conciliar_movimiento')
  @Patch(':id/estado-flujo')
  cambiarEstadoFlujo(@Param('id', ParseIntPipe) id: number, @Body() dto: CambiarEstadoFlujoDto, @Req() req: any) {
    return this.service.cambiarEstadoFlujo(id, dto.estado_flujo, req.user.userId);
  }

  @RequirePermissions('TESORERIA', 'anular_movimiento')
  @Patch(':id/anular')
  anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularMovimientoDto, @Req() req: any) {
    return this.service.anular(id, dto, req.user.userId);
  }

  @RequirePermissions('TESORERIA', 'ver_movimientos')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @RequirePermissions('TESORERIA', 'editar_movimiento')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMovimientoDto, @Req() req: any) {
    return this.service.update(id, dto, req.user.userId);
  }
}

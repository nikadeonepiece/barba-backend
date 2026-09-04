import {
  BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put,
  Query, Req, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { CajasService } from './cajas.service';
import { CONFIG_SUBIDA_COMPROBANTE } from './cajas-archivo.service';
import {
  CreateCajaDto, UpdateCajaDto, CreateMovimientoCajaDto, UpdateMovimientoCajaDto, AnularMovimientoCajaDto,
  RevisarMovimientoCajaDto,
} from './dto/caja.dto';

/**
 * Cajas chicas por empresa cliente.
 *
 * Orden de rutas: estáticas (`resumen`, `empresas`, `conceptos`, `comprobante`,
 * `exportar/*`) → el sub-recurso `movimientos/*` → dinámicas `:id` al final. Si
 * `@Get(':id')` estuviera arriba, capturaría `resumen` como id y el `ParseIntPipe`
 * respondería 400.
 *
 * `:id/movimientos` y `movimientos/:id` no chocan aunque los dos tengan dos
 * segmentos: en el primero el segundo segmento es el literal `movimientos`, en el
 * segundo lo es el primero.
 */
@Controller('tesoreria/cajas')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CajasController {
  constructor(private readonly service: CajasService) {}

  // ── Listado y catálogos ───────────────────────────────────────────────────

  @RequirePermissions('TESORERIA', 'ver_caja')
  @Get()
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @RequirePermissions('TESORERIA', 'ver_caja')
  @Get('resumen')
  resumen(@Query() query: any) {
    return this.service.resumen(query);
  }

  /**
   * Empresas del combo. Pide `ver_caja` y no `ver_vencimiento_tributario`: quien lo
   * consume es el filtro de ESTA pantalla, y exigir el permiso del catálogo de
   * empresas le daría 403 a alguien que solo administra cajas.
   */
  @RequirePermissions('TESORERIA', 'ver_caja')
  @Get('empresas')
  findEmpresas() {
    return this.service.findEmpresas();
  }

  @RequirePermissions('TESORERIA', 'ver_caja')
  @Get('conceptos')
  findConceptos() {
    return this.service.findConceptos();
  }

  // ── Exportaciones del listado ─────────────────────────────────────────────
  // Van ANTES de `:id/exportar/*` y de `:id`, si no `exportar` entra como id.

  @RequirePermissions('TESORERIA', 'exportar_excel_caja')
  @Get('exportar/excel')
  async exportarExcel(@Query() query: any, @Res() res: Response) {
    await this.service.exportarExcel(query, res);
  }

  @RequirePermissions('TESORERIA', 'exportar_pdf_caja')
  @Get('exportar/pdf')
  async exportarPdf(@Query() query: any, @Res() res: Response) {
    await this.service.exportarPdf(query, res);
  }

  // ── Movimientos ───────────────────────────────────────────────────────────

  /**
   * Paso 1 de la carga: sube el comprobante y devuelve su ruta. NO crea el movimiento.
   *
   * Se separa del POST del movimiento para que sus datos pasen por un DTO validado de
   * verdad: en `multipart/form-data` todo llega como string y `@IsNumber()` /
   * `@IsDateString()` dejarían de servir (mismo criterio que `planilla/contratos`).
   *
   * Si el usuario sube el archivo y cierra el modal sin guardar, el archivo queda
   * huérfano. El que SÍ se limpia es el de un guardado fallido: `createMovimiento` lo
   * borra en el catch.
   */
  @RequirePermissions('TESORERIA', 'crear_movimiento_caja')
  @Post('comprobante')
  @UseInterceptors(FileInterceptor('archivo', CONFIG_SUBIDA_COMPROBANTE))
  subirComprobante(@UploadedFile() archivo: Express.Multer.File) {
    if (!archivo) throw new BadRequestException('No se recibió ningún archivo');
    return {
      ruta: `/caja-comprobantes/${archivo.filename}`,
      nombre: archivo.originalname,
      tamano: archivo.size,
    };
  }

  @RequirePermissions('TESORERIA', 'crear_movimiento_caja')
  @Post('movimientos')
  createMovimiento(@Body() dto: CreateMovimientoCajaDto, @Req() req: any) {
    return this.service.createMovimiento(dto, req.user.userId);
  }

  @RequirePermissions('TESORERIA', 'ver_caja')
  @Get('movimientos/:id/comprobante')
  async descargarComprobante(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    await this.service.descargarComprobante(id, res);
  }

  /**
   * Aprobar o rechazar un gasto que cargó el cliente desde el portal.
   *
   * Permiso propio (`revisar_movimiento_caja`) y no `editar_movimiento_caja`: revisar es
   * el control sobre lo que el cliente escribe, y el estudio puede querer que lo haga
   * solo el contador a cargo aunque varios puedan registrar gastos.
   */
  @RequirePermissions('TESORERIA', 'revisar_movimiento_caja')
  @Patch('movimientos/:id/revisar')
  revisarMovimiento(@Param('id', ParseIntPipe) id: number, @Body() dto: RevisarMovimientoCajaDto, @Req() req: any) {
    return this.service.revisarMovimiento(id, dto, req.user.userId);
  }

  @RequirePermissions('TESORERIA', 'anular_movimiento_caja')
  @Post('movimientos/:id/anular')
  anularMovimiento(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularMovimientoCajaDto, @Req() req: any) {
    return this.service.anularMovimiento(id, dto, req.user.userId);
  }

  // PATCH y no PUT: el tipo y la caja del movimiento no se tocan acá (ver el DTO).
  @RequirePermissions('TESORERIA', 'editar_movimiento_caja')
  @Patch('movimientos/:id')
  updateMovimiento(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMovimientoCajaDto, @Req() req: any) {
    return this.service.updateMovimiento(id, dto, req.user.userId);
  }

  // ── Una caja ──────────────────────────────────────────────────────────────

  @RequirePermissions('TESORERIA', 'ver_caja')
  @Get(':id/movimientos')
  findMovimientos(@Param('id', ParseIntPipe) id: number, @Query() query: any) {
    return this.service.findMovimientos(id, query);
  }

  @RequirePermissions('TESORERIA', 'exportar_excel_caja')
  @Get(':id/exportar/excel')
  async exportarDetalleExcel(@Param('id', ParseIntPipe) id: number, @Query() query: any, @Res() res: Response) {
    await this.service.exportarDetalleExcel(id, query, res);
  }

  @RequirePermissions('TESORERIA', 'exportar_pdf_caja')
  @Get(':id/exportar/pdf')
  async exportarDetallePdf(@Param('id', ParseIntPipe) id: number, @Query() query: any, @Res() res: Response) {
    await this.service.exportarDetallePdf(id, query, res);
  }

  @RequirePermissions('TESORERIA', 'cerrar_caja')
  @Patch(':id/cerrar')
  cerrar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.cerrar(id, req.user.userId);
  }

  @RequirePermissions('TESORERIA', 'ver_caja')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @RequirePermissions('TESORERIA', 'crear_caja')
  @Post()
  create(@Body() dto: CreateCajaDto, @Req() req: any) {
    return this.service.create(dto, req.user.userId);
  }

  @RequirePermissions('TESORERIA', 'editar_caja')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCajaDto, @Req() req: any) {
    return this.service.update(id, dto, req.user.userId);
  }

  @RequirePermissions('TESORERIA', 'eliminar_caja')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remove(id, req.user.userId);
  }
}

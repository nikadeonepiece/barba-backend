import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req, Res, UploadedFile,
  UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { RequerimientosService } from './requerimientos.service';
import { CONFIG_SUBIDA_COMPROBANTE_REQ } from './requerimientos-archivo.service';
import {
  CreateRequerimientoDto, UpdateRequerimientoDto, ListarRequerimientosQueryDto,
} from './dto/requerimiento.dto';

/**
 * Requerimientos de compra — la pantalla que REGISTRA.
 *
 * Módulo de permisos `REQUERIMIENTOS`, separado de `APROBACION_REQUERIMIENTOS`: quien
 * pide no aprueba. Acá no hay ningún endpoint que cambie `estado_aprobacion`.
 *
 * Orden de rutas: estáticas (`buscar/*`, `medios-pago`, `exportar/*`) ANTES de las
 * dinámicas `:id`. Con `:id` declarado primero, NestJS tomaría 'buscar' como id y el
 * `ParseIntPipe` respondería 400.
 */
@Controller('cliente/requerimientos')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RequerimientosController {
  constructor(private readonly service: RequerimientosService) {}

  // ── CATÁLOGOS ───────────────────────────────────────────────────────────────

  @RequirePermissions('REQUERIMIENTOS', 'ver_requerimiento')
  @Get('buscar/empresas')
  buscarEmpresas(@Req() req: any, @Query('search') search = '', @Query('id') id?: string) {
    return this.service.buscarEmpresas(req.user, search, id ? Number(id) : undefined);
  }

  @RequirePermissions('REQUERIMIENTOS', 'ver_requerimiento')
  @Get('buscar/proveedores')
  buscarProveedores(@Req() req: any, @Query('search') search = '', @Query('id_empresa') idEmpresa?: string, @Query('id') id?: string) {
    return this.service.buscarProveedores(req.user, search, idEmpresa ? Number(idEmpresa) : undefined, id ? Number(id) : undefined);
  }

  @RequirePermissions('REQUERIMIENTOS', 'ver_requerimiento')
  @Get('buscar/personal')
  buscarPersonal(@Req() req: any, @Query('search') search = '', @Query('id_empresa') idEmpresa?: string, @Query('id') id?: string) {
    return this.service.buscarPersonal(req.user, search, idEmpresa ? Number(idEmpresa) : undefined, id ? Number(id) : undefined);
  }

  @RequirePermissions('REQUERIMIENTOS', 'ver_requerimiento')
  @Get('buscar/conceptos')
  buscarConceptos(@Req() req: any, @Query('search') search = '', @Query('id_empresa') idEmpresa?: string, @Query('id') id?: string) {
    return this.service.buscarConceptos(req.user, search, idEmpresa ? Number(idEmpresa) : undefined, id ? Number(id) : undefined);
  }

  @RequirePermissions('REQUERIMIENTOS', 'ver_requerimiento')
  @Get('medios-pago')
  getMediosPago() {
    return this.service.getMediosPago();
  }

  // ── EXPORTACIÓN ─────────────────────────────────────────────────────────────
  // `@Res()` desactiva el TransformInterceptor: el service escribe el archivo y el
  // controller no retorna nada.

  @RequirePermissions('REQUERIMIENTOS', 'exportar_excel_requerimiento')
  @Get('exportar/excel')
  async exportarExcel(@Req() req: any, @Query() query: any, @Res() res: Response) {
    await this.service.exportarExcel(query, res, req.user);
  }

  @RequirePermissions('REQUERIMIENTOS', 'exportar_pdf_requerimiento')
  @Get('exportar/pdf')
  async exportarPdf(@Req() req: any, @Query() query: any, @Res() res: Response) {
    await this.service.exportarPdf(query, res, req.user);
  }

  // ── LISTADO Y DETALLE ───────────────────────────────────────────────────────

  @RequirePermissions('REQUERIMIENTOS', 'ver_requerimiento')
  @Get()
  findAll(@Req() req: any, @Query() query: ListarRequerimientosQueryDto) {
    return this.service.findAll(query, false, req.user);
  }

  @RequirePermissions('REQUERIMIENTOS', 'crear_requerimiento')
  @Post()
  create(@Body() dto: CreateRequerimientoDto, @Req() req: any) {
    return this.service.create(dto, req.user);
  }

  // `:id/comprobante` no choca con `:id` porque tiene un segmento más.
  @RequirePermissions('REQUERIMIENTOS', 'ver_requerimiento')
  @Get(':id/comprobante')
  async verComprobante(@Param('id', ParseIntPipe) id: number, @Res() res: Response, @Req() req?: any) {
    await this.service.verComprobante(id, res, req?.user);
  }

  /**
   * La subida es un paso APARTE del guardado: el formulario manda JSON (los ítems son
   * un array anidado) y el archivo viaja como multipart. Mezclarlos obligaría a
   * serializar los detalles a string dentro del FormData y a parsearlos a mano acá,
   * perdiendo la validación del DTO.
   */
  @RequirePermissions('REQUERIMIENTOS', 'editar_requerimiento')
  @Post(':id/comprobante')
  @UseInterceptors(FileInterceptor('archivo', CONFIG_SUBIDA_COMPROBANTE_REQ))
  subirComprobante(@Param('id', ParseIntPipe) id: number, @UploadedFile() archivo: any, @Req() req: any) {
    return this.service.guardarComprobante(id, archivo, req.user);
  }

  @RequirePermissions('REQUERIMIENTOS', 'editar_requerimiento')
  @Delete(':id/comprobante')
  eliminarComprobante(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.eliminarComprobante(id, req.user);
  }

  @RequirePermissions('REQUERIMIENTOS', 'ver_requerimiento')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.findOne(id, req.user);
  }

  @RequirePermissions('REQUERIMIENTOS', 'editar_requerimiento')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRequerimientoDto, @Req() req: any) {
    return this.service.update(id, dto, req.user);
  }

  @RequirePermissions('REQUERIMIENTOS', 'eliminar_requerimiento')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remove(id, req.user);
  }
}

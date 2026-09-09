import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, ParseIntPipe,
  UseGuards, Req, Res, UseInterceptors, UploadedFile, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { PlanillasService } from './planillas.service';
import { CONFIG_SUBIDA_BOLETA_FIRMADA } from './boletas-firmadas-archivo.service';
import {
  CreatePlanillaDto, CreateEntradaDatoDto, GuardarTareoDto, RegistrarBoletaFirmadaDto,
} from './dto/planilla.dto';

/**
 * Planilla mensual.
 *
 * Los sub-recursos de `:id` van ANTES del `@Get(':id')` suelto: si el `:id` estuviera
 * primero no habría problema acá (los sub-recursos tienen un segmento extra), pero
 * mantener el orden es la convención del proyecto y evita el bug cuando alguien agregue
 * una ruta estática de un solo segmento más adelante.
 */
@Controller('planilla/planillas')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PlanillasController {
  constructor(private readonly service: PlanillasService) {}

  @RequirePermissions('PLANILLA', 'ver_planilla')
  @Get()
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @RequirePermissions('PLANILLA', 'crear_planilla')
  @Post()
  create(@Body() dto: CreatePlanillaDto, @Req() req: any) {
    return this.service.create(dto, req.user.userId);
  }

  // ---------- Entrada de datos ----------
  @RequirePermissions('PLANILLA', 'ver_planilla')
  @Get(':id/entradas')
  findEntradas(@Param('id', ParseIntPipe) id: number, @Query('origen') origen?: string) {
    return this.service.findEntradas(id, origen);
  }

  @RequirePermissions('PLANILLA', 'editar_entrada_datos')
  @Post(':id/entradas')
  createEntrada(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateEntradaDatoDto, @Req() req: any) {
    return this.service.createEntrada(id, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'editar_entrada_datos')
  @Delete(':id/entradas/:idEntrada')
  removeEntrada(
    @Param('id', ParseIntPipe) id: number,
    @Param('idEntrada', ParseIntPipe) idEntrada: number,
    @Req() req: any,
  ) {
    return this.service.removeEntrada(id, idEntrada, req.user.userId);
  }

  // ---------- Tareo ----------
  @RequirePermissions('PLANILLA', 'ver_planilla')
  @Get(':id/tareo')
  findTareo(@Param('id', ParseIntPipe) id: number, @Query('id_trabajador') idTrabajador?: string) {
    return this.service.findTareo(id, idTrabajador ? Number(idTrabajador) : undefined);
  }

  @RequirePermissions('PLANILLA', 'editar_tareo')
  @Post(':id/tareo')
  guardarTareo(@Param('id', ParseIntPipe) id: number, @Body() dto: GuardarTareoDto, @Req() req: any) {
    return this.service.guardarTareo(id, dto, req.user.userId);
  }

  // ---------- Resultado ----------
  @RequirePermissions('PLANILLA', 'ver_planilla')
  @Get(':id/detalle')
  findDetalle(@Param('id', ParseIntPipe) id: number) {
    return this.service.findDetalle(id);
  }

  // El PDF va declarado ANTES que la ruta de la boleta en JSON. No chocan (tiene un
  // segmento más), pero se mantiene el orden más-específico-primero que es la
  // convención del proyecto: el día que alguien agregue `:id/boleta/:algo` genérico,
  // este orden ya lo protege.
  //
  // `@Res()` SIN `passthrough`: deshabilita el TransformInterceptor, que si no
  // envolvería el binario del PDF dentro del JSON `{ success, data }`.
  @RequirePermissions('PLANILLA', 'generar_boleta')
  @Get(':id/boleta/:idTrabajador/pdf')
  async exportarBoletaPdf(
    @Param('id', ParseIntPipe) id: number,
    @Param('idTrabajador', ParseIntPipe) idTrabajador: number,
    @Res() res: Response,
  ) {
    await this.service.exportarBoletaPdf(id, idTrabajador, res);
  }

  @RequirePermissions('PLANILLA', 'generar_boleta')
  @Get(':id/boleta/:idTrabajador')
  findBoleta(@Param('id', ParseIntPipe) id: number, @Param('idTrabajador', ParseIntPipe) idTrabajador: number) {
    return this.service.findBoleta(id, idTrabajador);
  }

  // ---------- Boletas firmadas (el cargo de entrega escaneado) ----------
  // Todas cuelgan de `:id/firmadas`, así que tienen más segmentos que el `@Get(':id')`
  // del final y no chocan con él. `firmadas/subir` va ANTES de `firmadas/:idTrabajador`
  // o el `ParseIntPipe` intentaría leer "subir" como id y respondería 400.

  /**
   * Paso 1 de la carga: sube el PDF y devuelve su ruta relativa. NO registra nada.
   *
   * Se separa del `POST :id/firmadas` (paso 2) para que los datos pasen por un DTO que
   * valide de verdad: en `multipart/form-data` todo llega como string y `@IsInt()` /
   * `@IsDateString()` dejarían de servir. Mismo trato que `contratos/subir`.
   *
   * Contrapartida asumida: si el usuario sube el archivo y cierra el modal sin
   * guardar, queda un PDF huérfano en `storage-privado/boletas-firmadas`.
   */
  @RequirePermissions('PLANILLA', 'subir_boleta_firmada')
  @Post(':id/firmadas/subir')
  @UseInterceptors(FileInterceptor('archivo', CONFIG_SUBIDA_BOLETA_FIRMADA))
  subirFirmada(@UploadedFile() archivo: Express.Multer.File) {
    if (!archivo) throw new BadRequestException('No se recibió ningún archivo');
    return {
      ruta: `/boletas-firmadas/${archivo.filename}`,
      nombre: archivo.originalname,
      tamano: archivo.size,
    };
  }

  @RequirePermissions('PLANILLA', 'ver_boleta_firmada')
  @Get(':id/firmadas')
  findFirmadas(@Param('id', ParseIntPipe) id: number) {
    return this.service.findFirmadas(id);
  }

  @RequirePermissions('PLANILLA', 'subir_boleta_firmada')
  @Post(':id/firmadas')
  registrarFirmada(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RegistrarBoletaFirmadaDto,
    @Req() req: any,
  ) {
    return this.service.registrarFirmada(id, dto, req.user.userId);
  }

  /**
   * `@Res()` SIN `passthrough`: con `passthrough: true` el `TransformInterceptor`
   * seguiría aplicándose y envolvería el binario del PDF dentro del JSON
   * `{ success, data }`, rompiendo la descarga (mismo motivo que en contratos).
   */
  @RequirePermissions('PLANILLA', 'ver_boleta_firmada')
  @Get(':id/firmadas/:idTrabajador/archivo')
  async descargarFirmada(
    @Param('id', ParseIntPipe) id: number,
    @Param('idTrabajador', ParseIntPipe) idTrabajador: number,
    @Res() res: Response,
  ) {
    await this.service.descargarFirmada(id, idTrabajador, res);
  }

  @RequirePermissions('PLANILLA', 'eliminar_boleta_firmada')
  @Delete(':id/firmadas/:idTrabajador')
  eliminarFirmada(
    @Param('id', ParseIntPipe) id: number,
    @Param('idTrabajador', ParseIntPipe) idTrabajador: number,
    @Req() req: any,
  ) {
    return this.service.eliminarFirmada(id, idTrabajador, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'ver_planilla')
  @Get(':id/provisiones')
  findProvisiones(@Param('id', ParseIntPipe) id: number) {
    return this.service.findProvisiones(id);
  }

  @RequirePermissions('PLANILLA', 'ver_planilla')
  @Get(':id/resumen-tributos')
  findResumenTributos(@Param('id', ParseIntPipe) id: number) {
    return this.service.findResumenTributos(id);
  }

  // ---------- Acciones de estado (PATCH: cambio puntual, no reemplazo) ----------
  @RequirePermissions('PLANILLA', 'calcular_planilla')
  @Patch(':id/calcular')
  calcular(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.calcular(id, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'cerrar_planilla')
  @Patch(':id/cerrar')
  cerrar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.cerrar(id, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'cerrar_planilla')
  @Patch(':id/reabrir')
  reabrir(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.reabrir(id, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'anular_planilla')
  @Patch(':id/anular')
  anular(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.anular(id, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'ver_planilla')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }
}

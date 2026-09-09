import {
  BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { CajasClienteService } from './cajas-cliente.service';
import { CONFIG_SUBIDA_COMPROBANTE } from '../../estudio-barba/tesoreria/cajas/cajas-archivo.service';
import {
  CreateCajaClienteDto, UpdateCajaClienteDto, CreateMovimientoCajaClienteDto,
  UpdateMovimientoCajaClienteDto, AnularMovimientoCajaClienteDto,
} from './dto/caja-cliente.dto';

/**
 * Cajas chicas — PORTAL CLIENTE.
 *
 * A diferencia de `personal` y `planillas`, este módulo SÍ escribe, y es la tercera
 * excepción del área junto con `asistencia` y `modalidad-pago`. La justificación es
 * simple: LA CAJA ES DE LA EMPRESA. La abre ella, la maneja ella, la rinde ella y solo
 * ella tiene las boletas — hoy todo eso viaja por WhatsApp. El estudio valida por su
 * lado, en su sistema, y aquí no hay ningún circuito de aprobación en el medio.
 *
 * Por eso la empresa tiene la caja chica COMPLETA sobre sus propias cajas: abrir,
 * corregir, cerrar, registrar gastos y reposiciones, corregir y anular lo que cargó mal,
 * y sacar el arqueo en PDF.
 *
 * Lo que lo mantiene dentro del límite de `cliente.module.ts` es el SCOPE, no un
 * permiso recortado: todos los métodos pasan `req.user` al service, que resuelve la
 * empresa desde el token y la mete en el WHERE. El controller NUNCA lee un `id_empresa`
 * del query ni del body.
 *
 * Orden de rutas: estáticas (`conceptos`, `comprobante`, `movimientos/...`) ANTES de las
 * dinámicas `:id`.
 */
@Controller('cliente/cajas')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CajasClienteController {
  constructor(private readonly service: CajasClienteService) {}

  // ── Listado y catálogos ───────────────────────────────────────────────────

  @RequirePermissions('CAJAS_CLIENTE', 'ver_caja_cliente')
  @Get()
  findAll(@Req() req: any) {
    return this.service.findAll(req.user);
  }

  @RequirePermissions('CAJAS_CLIENTE', 'ver_caja_cliente')
  @Get('conceptos')
  findConceptos() {
    return this.service.findConceptos();
  }

  // ── Movimientos ───────────────────────────────────────────────────────────

  /**
   * Paso 1 de la carga: sube la boleta y devuelve su ruta. NO crea el movimiento.
   *
   * Se separa del POST del movimiento para que sus datos pasen por un DTO validado de
   * verdad: en `multipart/form-data` todo llega como string y `@IsNumber()` dejaría de
   * servir.
   */
  @RequirePermissions('CAJAS_CLIENTE', 'crear_movimiento_caja_cliente')
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

  @RequirePermissions('CAJAS_CLIENTE', 'crear_movimiento_caja_cliente')
  @Post('movimientos')
  crearMovimiento(@Body() dto: CreateMovimientoCajaClienteDto, @Req() req: any) {
    return this.service.crearMovimiento(req.user, dto, req.user.userId);
  }

  @RequirePermissions('CAJAS_CLIENTE', 'ver_caja_cliente')
  @Get('movimientos/:id/comprobante')
  async descargarComprobante(@Param('id', ParseIntPipe) id: number, @Req() req: any, @Res() res: Response) {
    await this.service.descargarComprobante(req.user, id, res);
  }

  @RequirePermissions('CAJAS_CLIENTE', 'anular_movimiento_caja_cliente')
  @Post('movimientos/:id/anular')
  anularMovimiento(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularMovimientoCajaClienteDto, @Req() req: any) {
    return this.service.anularMovimiento(req.user, id, dto, req.user.userId);
  }

  // PATCH y no PUT: el tipo y la caja del movimiento no se tocan acá (ver el DTO).
  @RequirePermissions('CAJAS_CLIENTE', 'editar_movimiento_caja_cliente')
  @Patch('movimientos/:id')
  actualizarMovimiento(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMovimientoCajaClienteDto, @Req() req: any) {
    return this.service.actualizarMovimiento(req.user, id, dto, req.user.userId);
  }

  // ── Una caja ──────────────────────────────────────────────────────────────

  @RequirePermissions('CAJAS_CLIENTE', 'ver_caja_cliente')
  @Get(':id/movimientos')
  findMovimientos(@Param('id', ParseIntPipe) id: number, @Req() req: any, @Query() query: any) {
    return this.service.findMovimientos(req.user, id, query);
  }

  /**
   * `@Res()` SIN `passthrough`: con `passthrough: true` el TransformInterceptor seguiría
   * envolviendo la respuesta y el PDF llegaría dentro de un JSON.
   */
  @RequirePermissions('CAJAS_CLIENTE', 'exportar_pdf_caja_cliente')
  @Get(':id/exportar/pdf')
  async exportarPdf(@Param('id', ParseIntPipe) id: number, @Req() req: any, @Query() query: any, @Res() res: Response) {
    await this.service.exportarPdf(req.user, id, query, res);
  }

  @RequirePermissions('CAJAS_CLIENTE', 'cerrar_caja_cliente')
  @Patch(':id/cerrar')
  cerrarCaja(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.cerrarCaja(req.user, id, req.user.userId);
  }

  @RequirePermissions('CAJAS_CLIENTE', 'ver_caja_cliente')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.findOne(req.user, id);
  }

  /**
   * Abre una caja chica para SU empresa. `id_empresa` no está en el DTO: lo resuelve el
   * service desde el token.
   */
  @RequirePermissions('CAJAS_CLIENTE', 'crear_caja_cliente')
  @Post()
  crearCaja(@Body() dto: CreateCajaClienteDto, @Req() req: any) {
    return this.service.crearCaja(req.user, dto, req.user.userId);
  }

  @RequirePermissions('CAJAS_CLIENTE', 'editar_caja_cliente')
  @Put(':id')
  actualizarCaja(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCajaClienteDto, @Req() req: any) {
    return this.service.actualizarCaja(req.user, id, dto, req.user.userId);
  }
}

import {
  BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { CajasClienteService } from './cajas-cliente.service';
import { CONFIG_SUBIDA_COMPROBANTE } from '../../estudio-barba/tesoreria/cajas/cajas-archivo.service';
import { CreateGastoCajaClienteDto } from './dto/caja-cliente.dto';

/**
 * Cajas chicas — PORTAL CLIENTE.
 *
 * A diferencia de `personal` y `planillas`, este módulo SÍ escribe, y es la tercera
 * excepción del área junto con `asistencia` y `modalidad-pago`. La justificación es la
 * misma: el gasto de caja lo hace la empresa y solo ella tiene la boleta — hoy eso viaja
 * por WhatsApp. Lo que la mantiene dentro del límite de `cliente.module.ts` es que el
 * monto NO entra a contabilidad solo: nace POR_REVISAR y no descuenta del saldo hasta
 * que alguien del estudio lo aprueba desde `tesoreria/cajas`.
 *
 * El cliente solo puede registrar EGRESOS y nunca aprobar: reponer el fondo y aprobar
 * son del estudio.
 *
 * Todos los métodos pasan `req.user` al service, que resuelve la empresa desde el token.
 * El controller NUNCA lee un `id_empresa` del query ni del body.
 *
 * Orden de rutas: estáticas (`conceptos`, `comprobante`, `movimientos/...`) ANTES de las
 * dinámicas `:id`.
 */
@Controller('cliente/cajas')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CajasClienteController {
  constructor(private readonly service: CajasClienteService) {}

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

  /**
   * Paso 1 de la carga: sube la boleta y devuelve su ruta. NO crea el gasto.
   *
   * Se separa del POST del gasto para que sus datos pasen por un DTO validado de verdad:
   * en `multipart/form-data` todo llega como string y `@IsNumber()` dejaría de servir.
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
  crearGasto(@Body() dto: CreateGastoCajaClienteDto, @Req() req: any) {
    return this.service.crearGasto(req.user, dto, req.user.userId);
  }

  @RequirePermissions('CAJAS_CLIENTE', 'ver_caja_cliente')
  @Get('movimientos/:id/comprobante')
  async descargarComprobante(@Param('id', ParseIntPipe) id: number, @Req() req: any, @Res() res: Response) {
    await this.service.descargarComprobante(req.user, id, res);
  }

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

  @RequirePermissions('CAJAS_CLIENTE', 'ver_caja_cliente')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.findOne(req.user, id);
  }
}

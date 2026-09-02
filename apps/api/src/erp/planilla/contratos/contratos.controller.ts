import {
  BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put,
  Query, Req, Res, UseGuards, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { ContratosService } from './contratos.service';
import { CONFIG_SUBIDA_CONTRATO } from './contratos-archivo.service';
import { CreateContratoDto, UpdateContratoDto } from './dto/contrato.dto';

/**
 * Contratos del legajo — pantalla de la INTRANET (el estudio carga, el cliente lee).
 *
 * Orden de rutas: estáticas (`subir`, la raíz) → dinámicas `:id` al final. Si
 * `@Get(':id')` estuviera arriba, capturaría `subir` como id y el `ParseIntPipe`
 * respondería 400.
 *
 * `:id/archivo` no choca con `:id` porque tiene un segmento más.
 */
@Controller('planilla/contratos')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ContratosController {
  constructor(private readonly service: ContratosService) {}

  /**
   * Paso 1 de la carga: sube el PDF y devuelve su ruta relativa. NO crea el contrato.
   *
   * Se separa de `POST /` (paso 2) para que los datos del contrato pasen por un DTO
   * validado de verdad: en `multipart/form-data` todos los campos llegan como string y
   * `@IsInt()`/`@IsDateString()` dejarían de servir.
   *
   * Contrapartida asumida: si el usuario sube el archivo y cierra el modal sin
   * guardar, queda un PDF huérfano en `storage-privado/contratos`. Es el mismo trato
   * que ya hace el módulo de constancias y, para el volumen de este estudio, sale más
   * barato que un flujo transaccional de dos fases.
   */
  @RequirePermissions('PLANILLA', 'crear_contrato')
  @Post('subir')
  @UseInterceptors(FileInterceptor('archivo', CONFIG_SUBIDA_CONTRATO))
  subir(@UploadedFile() archivo: Express.Multer.File) {
    if (!archivo) throw new BadRequestException('No se recibió ningún archivo');
    return {
      ruta: `/contratos/${archivo.filename}`,
      nombre: archivo.originalname,
      tamano: archivo.size,
    };
  }

  /**
   * Catálogo abierto para el `<ng-select>` de trabajadores: búsqueda en backend,
   * paginada de a 30. Endpoint propio (`buscar/<catalogo>`) y no uno que llene varios
   * selects de un golpe — regla 17a de CLAUDE.md.
   *
   * Pide `ver_contrato` porque quien lo consume es el formulario de esta pantalla; no
   * exige `ver_trabajador`, que le daría 403 a alguien que solo administra el legajo
   * documental (mismo criterio que el catálogo de Tabla 22 en planilla/configuracion).
   */
  @RequirePermissions('PLANILLA', 'ver_contrato')
  @Get('buscar/trabajadores')
  buscarTrabajadores(@Query() query: any) {
    return this.service.buscarTrabajadores(query);
  }

  // Empresas sí van precargadas completas: son 171 y es lo que ya hace
  // `planilla/trabajadores` con su `GET empresas`. Cambiarlo solo acá dejaría dos
  // comportamientos distintos para el mismo dropdown en pantallas vecinas.
  @RequirePermissions('PLANILLA', 'ver_contrato')
  @Get('buscar/empresas')
  buscarEmpresas() {
    return this.service.buscarEmpresas();
  }

  @RequirePermissions('PLANILLA', 'ver_contrato')
  @Get()
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @RequirePermissions('PLANILLA', 'crear_contrato')
  @Post()
  create(@Body() dto: CreateContratoDto, @Req() req: any) {
    return this.service.create(dto, req.user.userId);
  }

  /**
   * `@Res()` SIN `passthrough`: con `passthrough: true` el `TransformInterceptor`
   * seguiría aplicándose y envolvería el binario del PDF dentro del JSON
   * `{ success, data }`, rompiendo la descarga (mismo motivo que en las constancias).
   */
  @RequirePermissions('PLANILLA', 'ver_contrato')
  @Get(':id/archivo')
  async descargar(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    await this.service.descargar(id, res);
  }

  @RequirePermissions('PLANILLA', 'ver_contrato')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @RequirePermissions('PLANILLA', 'editar_contrato')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateContratoDto, @Req() req: any) {
    return this.service.update(id, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'eliminar_contrato')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remove(id, req.user.userId);
  }
}

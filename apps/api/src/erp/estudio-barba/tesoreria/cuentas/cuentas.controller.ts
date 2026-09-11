import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { CuentasService } from './cuentas.service';
import { CreateCuentaDto, UpdateCuentaDto, ListarCuentasQueryDto } from './dto/cuenta.dto';

/**
 * Cuentas bancarias por empresa.
 *
 * Permisos del módulo `TESORERIA`, que ya existían desde la sección 7 de `bd.sql`:
 * `ver_cuentas`, `crear_cuenta`, `editar_cuenta`, `eliminar_cuenta`.
 *
 * Orden de rutas: `catalogos` y `buscar/*` (estáticas) antes de `:id`.
 */
@Controller('tesoreria/cuentas')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CuentasController {
  constructor(private readonly service: CuentasService) {}

  @RequirePermissions('TESORERIA', 'ver_cuentas')
  @Get('catalogos')
  getCatalogos() {
    return this.service.getCatalogos();
  }

  @RequirePermissions('TESORERIA', 'ver_cuentas')
  @Get('buscar/empresas')
  buscarEmpresas(@Query('search') search = '', @Query('id') id?: string) {
    return this.service.buscarEmpresas(search, id ? Number(id) : undefined);
  }

  @RequirePermissions('TESORERIA', 'exportar_excel_tesoreria')
  @Get('exportar/excel')
  async exportarExcel(@Query() query: any, @Res() res: Response) {
    await this.service.exportarExcel(query, res);
  }

  @RequirePermissions('TESORERIA', 'ver_cuentas')
  @Get()
  findAll(@Query() query: ListarCuentasQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('TESORERIA', 'crear_cuenta')
  @Post()
  create(@Body() dto: CreateCuentaDto, @Req() req: any) {
    return this.service.create(dto, req.user.userId);
  }

  @RequirePermissions('TESORERIA', 'ver_cuentas')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @RequirePermissions('TESORERIA', 'editar_cuenta')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCuentaDto, @Req() req: any) {
    return this.service.update(id, dto, req.user.userId);
  }

  @RequirePermissions('TESORERIA', 'eliminar_cuenta')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remove(id, req.user.userId);
  }
}

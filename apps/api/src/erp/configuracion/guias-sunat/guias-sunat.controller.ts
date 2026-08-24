import { Controller, Get, Post, Put, Delete, Body, Param, Query, ParseIntPipe, UseGuards, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { GuiasSunatService } from './guias-sunat.service';
import { CreateGuiaSunatDto, UpdateGuiaSunatDto } from './dto/guia-sunat.dto';

@Controller('configuraciones/guias-sunat')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class GuiasSunatController {
  constructor(private readonly service: GuiasSunatService) {}

  @RequirePermissions('CONFIGURACIONES', 'ver_guias_sunat')
  @Get()
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @RequirePermissions('CONFIGURACIONES', 'ver_guias_sunat')
  @Get(':id/pdf')
  async exportarPdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    await this.service.exportarPdf(id, res);
  }

  @RequirePermissions('CONFIGURACIONES', 'ver_guias_sunat')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @RequirePermissions('CONFIGURACIONES', 'crear_guia_sunat')
  @Post()
  create(@Body() dto: CreateGuiaSunatDto, @Req() req: any) {
    return this.service.create(dto, req.user.userId);
  }

  @RequirePermissions('CONFIGURACIONES', 'editar_guia_sunat')
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateGuiaSunatDto, @Req() req: any) {
    return this.service.update(id, dto, req.user.userId);
  }

  @RequirePermissions('CONFIGURACIONES', 'eliminar_guia_sunat')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remove(id, req.user.userId);
  }
}

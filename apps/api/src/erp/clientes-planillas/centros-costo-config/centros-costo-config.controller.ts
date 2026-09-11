import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { CentrosCostoConfigService } from './centros-costo-config.service';
import {
  CreateCategoriaDto, UpdateCategoriaDto,
  CreateSubcategoriaDto, UpdateSubcategoriaDto,
  CreateConceptoDto, UpdateConceptoDto,
} from './dto/centros-costo-config.dto';

/**
 * Centros de costo — configuración del árbol por empresa.
 *
 * La pantalla atiende a los DOS públicos: el estudio elige la empresa en un
 * desplegable y ve las 171; una cuenta de portal solo ve la suya. La diferencia NO la
 * hace el permiso —es el mismo— sino `empresaEfectiva()` dentro del service, que para
 * el portal fuerza la empresa del token e ignora lo que mande el frontend.
 *
 * Por eso el módulo de permisos es `CENTROS_COSTO` y no `PLANILLAS_CLIENTE`: son dos
 * cosas distintas. El módulo dice QUÉ PANTALLA puede abrirse (y se le puede dar tanto
 * al estudio como al cliente); el scope decide QUÉ FILAS ve cada uno.
 *
 * Orden de rutas: primero las estáticas (`buscar/*`, `exportar/*`), después los
 * sub-recursos (`categorias`, `subcategorias`, `conceptos`) y sus `:id` al final de
 * cada grupo. Con `categorias/:id` declarado antes que `buscar/categorias`, NestJS
 * tomaría 'buscar' como id y el `ParseIntPipe` respondería 400.
 */
@Controller('cliente/centros-costo-config')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CentrosCostoConfigController {
  constructor(private readonly service: CentrosCostoConfigService) {}

  // ── BUSCADORES DE LOS ng-select ─────────────────────────────────────────────

  @RequirePermissions('CENTROS_COSTO', 'ver_centro_costo_config')
  @Get('buscar/empresas')
  buscarEmpresas(@Req() req: any, @Query('search') search = '', @Query('id') id?: string) {
    return this.service.buscarEmpresas(req.user, search, id ? Number(id) : undefined);
  }

  @RequirePermissions('CENTROS_COSTO', 'ver_centro_costo_config')
  @Get('buscar/categorias')
  buscarCategorias(
    @Req() req: any,
    @Query('search') search = '',
    @Query('id_empresa') idEmpresa?: string,
    @Query('id') id?: string,
  ) {
    return this.service.buscarCategoriasSelect(
      req.user,
      search,
      idEmpresa ? Number(idEmpresa) : undefined,
      id ? Number(id) : undefined,
    );
  }

  @RequirePermissions('CENTROS_COSTO', 'ver_centro_costo_config')
  @Get('buscar/subcategorias')
  buscarSubcategorias(
    @Req() req: any,
    @Query('search') search = '',
    @Query('id_categoria') idCategoria?: string,
    @Query('id') id?: string,
  ) {
    return this.service.buscarSubcategoriasSelect(
      req.user,
      search,
      idCategoria ? Number(idCategoria) : undefined,
      id ? Number(id) : undefined,
    );
  }

  // ── EXPORTACIÓN ─────────────────────────────────────────────────────────────
  // `@Res()` desactiva el TransformInterceptor: el service escribe el archivo en la
  // respuesta y el controller no retorna nada.

  @RequirePermissions('CENTROS_COSTO', 'exportar_excel_centro_costo_config')
  @Get('exportar/excel')
  async exportarExcel(@Req() req: any, @Query('tipo') tipo: string, @Query() query: any, @Res() res: Response) {
    await this.service.exportarExcel(req.user, tipo, query, res);
  }

  @RequirePermissions('CENTROS_COSTO', 'exportar_pdf_centro_costo_config')
  @Get('exportar/pdf')
  async exportarPdf(@Req() req: any, @Query('tipo') tipo: string, @Query() query: any, @Res() res: Response) {
    await this.service.exportarPdf(req.user, tipo, query, res);
  }

  // ── CATEGORÍAS ──────────────────────────────────────────────────────────────

  @RequirePermissions('CENTROS_COSTO', 'ver_centro_costo_config')
  @Get('categorias')
  findAllCategorias(@Req() req: any, @Query() query: any) {
    return this.service.findAllCategorias(
      req.user,
      Number(query.page) || 1,
      Number(query.limit) || 20,
      query.search || '',
      query.id_empresa ? Number(query.id_empresa) : undefined,
    );
  }

  @RequirePermissions('CENTROS_COSTO', 'crear_centro_costo_config')
  @Post('categorias')
  createCategoria(@Body() dto: CreateCategoriaDto, @Req() req: any) {
    return this.service.createCategoria(dto, req.user);
  }

  @RequirePermissions('CENTROS_COSTO', 'editar_centro_costo_config')
  @Put('categorias/:id')
  updateCategoria(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCategoriaDto, @Req() req: any) {
    return this.service.updateCategoria(id, dto, req.user);
  }

  @RequirePermissions('CENTROS_COSTO', 'eliminar_centro_costo_config')
  @Delete('categorias/:id')
  removeCategoria(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.removeCategoria(id, req.user);
  }

  // ── SUBCATEGORÍAS ───────────────────────────────────────────────────────────

  @RequirePermissions('CENTROS_COSTO', 'ver_centro_costo_config')
  @Get('subcategorias')
  findAllSubcategorias(@Req() req: any, @Query() query: any) {
    return this.service.findAllSubcategorias(
      req.user,
      Number(query.page) || 1,
      Number(query.limit) || 20,
      query.search || '',
      query.id_categoria ? Number(query.id_categoria) : undefined,
    );
  }

  @RequirePermissions('CENTROS_COSTO', 'crear_centro_costo_config')
  @Post('subcategorias')
  createSubcategoria(@Body() dto: CreateSubcategoriaDto, @Req() req: any) {
    return this.service.createSubcategoria(dto, req.user);
  }

  @RequirePermissions('CENTROS_COSTO', 'editar_centro_costo_config')
  @Put('subcategorias/:id')
  updateSubcategoria(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSubcategoriaDto, @Req() req: any) {
    return this.service.updateSubcategoria(id, dto, req.user);
  }

  @RequirePermissions('CENTROS_COSTO', 'eliminar_centro_costo_config')
  @Delete('subcategorias/:id')
  removeSubcategoria(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.removeSubcategoria(id, req.user);
  }

  // ── CONCEPTOS ───────────────────────────────────────────────────────────────

  @RequirePermissions('CENTROS_COSTO', 'ver_centro_costo_config')
  @Get('conceptos')
  findAllConceptos(@Req() req: any, @Query() query: any) {
    return this.service.findAllConceptos(
      req.user,
      Number(query.page) || 1,
      Number(query.limit) || 20,
      query.search || '',
      query.id_subcategoria ? Number(query.id_subcategoria) : undefined,
      query.id_categoria ? Number(query.id_categoria) : undefined,
      query.id_empresa ? Number(query.id_empresa) : undefined,
      query.sortCol,
      query.sortDir === 'DESC' ? 'DESC' : 'ASC',
    );
  }

  @RequirePermissions('CENTROS_COSTO', 'crear_centro_costo_config')
  @Post('conceptos')
  createConcepto(@Body() dto: CreateConceptoDto, @Req() req: any) {
    return this.service.createConcepto(dto, req.user);
  }

  @RequirePermissions('CENTROS_COSTO', 'editar_centro_costo_config')
  @Put('conceptos/:id')
  updateConcepto(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateConceptoDto, @Req() req: any) {
    return this.service.updateConcepto(id, dto, req.user);
  }

  @RequirePermissions('CENTROS_COSTO', 'eliminar_centro_costo_config')
  @Delete('conceptos/:id')
  removeConcepto(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.removeConcepto(id, req.user);
  }
}

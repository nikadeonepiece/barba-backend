import { Controller, Get, Post, Patch, Body, Param, Query, ParseIntPipe, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { BeneficiosService } from './beneficios.service';
import { CreateBeneficioDto, ActualizarPagoDto } from './dto/beneficio.dto';

@Controller('planilla/beneficios')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BeneficiosController {
  constructor(private readonly service: BeneficiosService) {}

  @RequirePermissions('PLANILLA', 'ver_beneficio')
  @Get()
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @RequirePermissions('PLANILLA', 'calcular_beneficio')
  @Post()
  create(@Body() dto: CreateBeneficioDto, @Req() req: any) {
    return this.service.create(dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'ver_beneficio')
  @Get(':id/detalle')
  findDetalle(@Param('id', ParseIntPipe) id: number) {
    return this.service.findDetalle(id);
  }

  @RequirePermissions('PLANILLA', 'ver_beneficio')
  @Get(':id/boleta/:idTrabajador')
  findBoleta(@Param('id', ParseIntPipe) id: number, @Param('idTrabajador', ParseIntPipe) idTrabajador: number) {
    return this.service.findBoleta(id, idTrabajador);
  }

  @RequirePermissions('PLANILLA', 'calcular_beneficio')
  @Patch(':id/calcular')
  calcular(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.calcular(id, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'calcular_beneficio')
  @Patch(':id/pago')
  actualizarPago(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarPagoDto, @Req() req: any) {
    return this.service.actualizarPago(id, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'cerrar_beneficio')
  @Patch(':id/cerrar')
  cerrar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.cerrar(id, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'cerrar_beneficio')
  @Patch(':id/reabrir')
  reabrir(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.reabrir(id, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'cerrar_beneficio')
  @Patch(':id/anular')
  anular(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.anular(id, req.user.userId);
  }

  @RequirePermissions('PLANILLA', 'ver_beneficio')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }
}

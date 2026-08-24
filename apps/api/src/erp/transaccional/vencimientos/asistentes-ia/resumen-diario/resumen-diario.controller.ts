import { Controller, Get, Query, UseGuards, ParseIntPipe, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { ResumenDiarioService } from './resumen-diario.service';

@Controller('vencimientos/asistentes-ia/resumen-diario')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ResumenDiarioController {
  constructor(private readonly service: ResumenDiarioService) {}

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_vencimiento_tributario')
  @Get()
  generar(@Query('anio', ParseIntPipe) anio: number, @Query('mes', ParseIntPipe) mes: number, @Req() req: any) {
    return this.service.generar(anio, mes, req.user.userId);
  }
}

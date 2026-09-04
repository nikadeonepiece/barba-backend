import { Controller, Get, Post, Body, Param, UseGuards, ParseIntPipe, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { ParametrosTributariosService } from './parametros-tributarios.service';
import { UpsertParametroDto } from './dto/parametro-tributario.dto';

@Controller('configuraciones/parametros-tributarios')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ParametrosTributariosController {
  constructor(private readonly service: ParametrosTributariosService) {}

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'editar_cronograma')
  @Post()
  upsert(@Body() dto: UpsertParametroDto, @Req() req: any) {
    return this.service.upsert(dto, req.user.userId);
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_vencimiento_tributario')
  @Get(':anio')
  listarPorAnio(@Param('anio', ParseIntPipe) anio: number) {
    return this.service.listarPorAnio(anio);
  }
}

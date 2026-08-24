import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { DeteccionInconsistenciasService } from './deteccion-inconsistencias.service';

@Controller('vencimientos/asistentes-ia/inconsistencias')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DeteccionInconsistenciasController {
  constructor(private readonly service: DeteccionInconsistenciasService) {}

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'usar_asistente_ia')
  @Get()
  analizar(@Req() req: any) {
    return this.service.analizar(req.user.userId);
  }
}

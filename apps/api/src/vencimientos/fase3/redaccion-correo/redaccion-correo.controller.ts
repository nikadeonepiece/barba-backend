import { Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { RedaccionCorreoService } from './redaccion-correo.service';
import { RedactarCorreoDto } from './dto/redaccion-correo.dto';

@Controller('vencimientos/fase3/redaccion-correo')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RedaccionCorreoController {
  constructor(private readonly service: RedaccionCorreoService) {}

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'usar_asistente_ia')
  @Post()
  redactar(@Body() dto: RedactarCorreoDto, @Req() req: any) {
    return this.service.redactar(dto, req.user.userId);
  }
}

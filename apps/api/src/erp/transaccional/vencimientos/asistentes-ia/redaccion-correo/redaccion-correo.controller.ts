import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { RedaccionCorreoService } from './redaccion-correo.service';
import { RedactarCorreoDto } from './dto/redaccion-correo.dto';

@Controller('vencimientos/asistentes-ia/redaccion-correo')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RedaccionCorreoController {
  constructor(private readonly service: RedaccionCorreoService) {}

  // Rutas estáticas antes que nada (orden de rutas, CLAUDE.md §3).
  // El frontend lo consulta al entrar para avisar ANTES de que el usuario escriba
  // todo el correo: este asistente es el único sin modo sin-IA, así que sin
  // ANTHROPIC_API_KEY solo puede fallar al momento de redactar.
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'usar_asistente_ia')
  @Get('estado')
  estado() {
    return { disponible: this.service.iaDisponible };
  }

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'usar_asistente_ia')
  @Post()
  redactar(@Body() dto: RedactarCorreoDto, @Req() req: any) {
    return this.service.redactar(dto, req.user.userId);
  }
}

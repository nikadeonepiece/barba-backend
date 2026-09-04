import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { AsistenciaClienteService } from './asistencia.service';
import { GuardarAsistenciaDto, LlenarMesDto } from './dto/asistencia.dto';

/**
 * Asistencia — PORTAL CLIENTE.
 *
 * Es el único controller del portal con verbos de escritura, y va con permisos
 * PROPIOS (`editar_asistencia_cliente`), separados de los de lectura: hay empresas
 * donde el dueño quiere mirar la asistencia sin poder cambiarla, y con un solo permiso
 * eso no se puede expresar.
 *
 * Todos los métodos pasan `req.user` al service, que resuelve la empresa desde el
 * token. El controller NUNCA lee un `id_empresa` del query ni del body: si lo hiciera,
 * bastaría cambiar un número para marcarle asistencia al personal de otra empresa.
 *
 * Todas las rutas son estáticas: no hay `:id`, así que no hay nada que ordenar.
 */
@Controller('cliente/asistencia')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AsistenciaClienteController {
  constructor(private readonly service: AsistenciaClienteService) {}

  /**
   * Pide `ver_asistencia_cliente` y no un permiso de configuración: la leyenda es
   * parte de esta pantalla y quien la abre ya tiene que poder verla. Es el mismo
   * criterio que usa `planilla/configuracion/catalogo/:tablaNum` con `ver_trabajador`.
   */
  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_asistencia_cliente')
  @Get('marcas')
  marcas() {
    return this.service.marcas();
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_asistencia_cliente')
  @Get('areas')
  areas(@Req() req: any) {
    return this.service.areas(req.user);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'ver_asistencia_cliente')
  @Get()
  periodo(@Req() req: any, @Query() query: any) {
    return this.service.periodo(req.user, query);
  }

  /** `@Post` y no `@Put`: la URL no identifica un recurso, el mes va en el body. */
  @RequirePermissions('PLANILLAS_CLIENTE', 'editar_asistencia_cliente')
  @Post()
  guardar(@Body() dto: GuardarAsistenciaDto, @Req() req: any) {
    return this.service.guardar(req.user, dto, req.user.userId);
  }

  @RequirePermissions('PLANILLAS_CLIENTE', 'editar_asistencia_cliente')
  @Post('llenar-mes')
  llenarMes(@Body() dto: LlenarMesDto, @Req() req: any) {
    return this.service.llenarMes(req.user, dto, req.user.userId);
  }
}

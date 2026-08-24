import { Controller, Post, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { SunatSyncService } from './sunat-sync.service';

const TIPOS_TRIBUTARIO = ['IGV_RENTA', 'RCE_RVIE_SIRE'];
// ⚠️ A propósito NO incluye AFP_NET, aunque el semáforo laboral sí lo muestre:
// AFPnet es un portal de las AFP, no de SUNAT, y no hay integración con él —
// esa obligación se marca a mano. Si se agrega acá, el usuario recibiría un
// ERROR_VERIFICACION en cada intento.
const TIPOS_LABORAL = ['PLANILLA'];

/**
 * Disparo manual del job de Fase 2, mientras se define el mecanismo de cron
 * de producción (Windows Task Scheduler / crontab del hosting apuntando acá,
 * o @nestjs/schedule con @Cron una vez instalado). No requiere que nadie
 * esté mirando la pantalla, solo que algo llame este endpoint a la hora fijada.
 */
@Controller('vencimientos/sincronizacion-sunat')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SunatSyncController {
  constructor(private readonly sunatSyncService: SunatSyncService) {}

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_credenciales_sunat')
  @Post('sincronizar')
  sincronizar(@Body('periodo_anio') periodoAnio: number, @Body('periodo_mes') periodoMes: number) {
    return this.sunatSyncService.ejecutar(periodoAnio, periodoMes);
  }

  // Botón "Verificar con SUNAT" del Semáforo tributario: una sola empresa/periodo.
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'marcar_declaracion')
  @Post('verificar-empresa')
  verificarEmpresa(
    @Body('id_empresa') idEmpresa: number,
    @Body('tipo_obligacion') tipoObligacion: string,
    @Body('periodo_anio') periodoAnio: number,
    @Body('periodo_mes') periodoMes: number,
  ) {
    if (!TIPOS_TRIBUTARIO.includes(tipoObligacion)) {
      throw new BadRequestException('Este endpoint solo admite obligaciones tributarias (IGV_RENTA, RCE_RVIE_SIRE)');
    }
    return this.sunatSyncService.verificarUnaEmpresa(idEmpresa, tipoObligacion as any, periodoAnio, periodoMes);
  }

  // Botón "Verificar con SUNAT" del Semáforo laboral: una sola empresa/periodo, solo Planilla.
  @RequirePermissions('VENCIMIENTOS_LABORAL', 'marcar_declaracion_laboral')
  @Post('laboral/verificar-empresa')
  verificarEmpresaLaboral(
    @Body('id_empresa') idEmpresa: number,
    @Body('tipo_obligacion') tipoObligacion: string,
    @Body('periodo_anio') periodoAnio: number,
    @Body('periodo_mes') periodoMes: number,
  ) {
    if (!TIPOS_LABORAL.includes(tipoObligacion)) {
      throw new BadRequestException('Este endpoint solo admite la obligación PLANILLA');
    }
    return this.sunatSyncService.verificarUnaEmpresa(idEmpresa, tipoObligacion as any, periodoAnio, periodoMes);
  }
}

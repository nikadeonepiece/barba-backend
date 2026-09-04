import { Module } from '@nestjs/common';
import { ResumenDiarioService } from './resumen-diario/resumen-diario.service';
import { ResumenDiarioController } from './resumen-diario/resumen-diario.controller';
import { DeteccionInconsistenciasService } from './inconsistencias/deteccion-inconsistencias.service';
import { DeteccionInconsistenciasController } from './inconsistencias/deteccion-inconsistencias.controller';
import { RedaccionCorreoService } from './redaccion-correo/redaccion-correo.service';
import { RedaccionCorreoController } from './redaccion-correo/redaccion-correo.controller';
import { AsistenteIaBaseService } from './base/asistente-ia-base.service';

/**
 * Los tres asistentes de IA del ERP, más el servicio base que comparten
 * (rate limiting por usuario, tope de tokens y registro de costo en `uso_ia`).
 *
 * Antes era `fase3.module.ts` y además declaraba ParametrosTributarios, que
 * no es un asistente: se movió a erp/estudio-barba/configuracion/parametros-tributarios/.
 */
@Module({
  controllers: [
    ResumenDiarioController,
    DeteccionInconsistenciasController,
    RedaccionCorreoController,
  ],
  providers: [
    ResumenDiarioService,
    DeteccionInconsistenciasService,
    RedaccionCorreoService,
    AsistenteIaBaseService,
  ],
  exports: [ResumenDiarioService, DeteccionInconsistenciasService, RedaccionCorreoService],
})
export class AsistentesIaModule {}

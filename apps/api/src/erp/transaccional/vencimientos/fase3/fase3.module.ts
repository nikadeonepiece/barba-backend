import { Module } from '@nestjs/common';
import { ParametrosTributariosService } from './parametros/parametros-tributarios.service';
import { ParametrosTributariosController } from './parametros/parametros-tributarios.controller';
import { ResumenDiarioService } from './resumen-diario/resumen-diario.service';
import { ResumenDiarioController } from './resumen-diario/resumen-diario.controller';
import { DeteccionInconsistenciasService } from './deteccion-inconsistencias/deteccion-inconsistencias.service';
import { DeteccionInconsistenciasController } from './deteccion-inconsistencias/deteccion-inconsistencias.controller';
import { RedaccionCorreoService } from './redaccion-correo/redaccion-correo.service';
import { RedaccionCorreoController } from './redaccion-correo/redaccion-correo.controller';
import { AsistenteIaBaseService } from './ia/asistente-ia-base.service';

@Module({
  controllers: [
    ParametrosTributariosController,
    ResumenDiarioController,
    DeteccionInconsistenciasController,
    RedaccionCorreoController,
  ],
  providers: [
    ParametrosTributariosService,
    ResumenDiarioService,
    DeteccionInconsistenciasService,
    RedaccionCorreoService,
    AsistenteIaBaseService,
  ],
  exports: [ParametrosTributariosService, ResumenDiarioService, DeteccionInconsistenciasService, RedaccionCorreoService],
})
export class Fase3Module {}

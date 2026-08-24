import { Module } from '@nestjs/common';
import { EmpresasModule } from '../../catalogos/empresas/empresas.module';
import { DeclaracionesModule } from './declaraciones/declaraciones.module';
import { SincronizacionSunatModule } from './sincronizacion-sunat/sincronizacion-sunat.module';
import { AsistentesIaModule } from './asistentes-ia/asistentes-ia.module';
import { SireModule } from './sire/sire.module';
import { SunafilModule } from './sunafil/sunafil.module';
import { BuzonSunatModule } from './buzon/buzon-sunat.module';

@Module({
  imports: [EmpresasModule, DeclaracionesModule, SincronizacionSunatModule, AsistentesIaModule, SireModule, SunafilModule, BuzonSunatModule],
  exports: [EmpresasModule, DeclaracionesModule, SincronizacionSunatModule, AsistentesIaModule, SireModule, SunafilModule, BuzonSunatModule],
})
export class VencimientosModule {}

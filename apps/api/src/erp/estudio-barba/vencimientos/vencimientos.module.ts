import { Module } from '@nestjs/common';
import { EmpresasModule } from '../catalogos/empresas/empresas.module';
import { DeclaracionesModule } from './declaraciones/declaraciones.module';
import { SincronizacionSunatModule } from './sincronizacion-sunat/sincronizacion-sunat.module';
import { AsistentesIaModule } from './asistentes-ia/asistentes-ia.module';
import { SireModule } from './sire/sire.module';
import { PleModule } from './ple/ple.module';
import { SunafilModule } from './sunafil/sunafil.module';
import { BuzonSunatModule } from './buzon/buzon-sunat.module';

@Module({
  imports: [EmpresasModule, DeclaracionesModule, SincronizacionSunatModule, AsistentesIaModule, SireModule, PleModule, SunafilModule, BuzonSunatModule],
  exports: [EmpresasModule, DeclaracionesModule, SincronizacionSunatModule, AsistentesIaModule, SireModule, PleModule, SunafilModule, BuzonSunatModule],
})
export class VencimientosModule {}

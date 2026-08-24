import { Module } from '@nestjs/common';
import { EmpresasModule } from '../../catalogos/empresas/empresas.module';
import { DeclaracionesModule } from './declaraciones/declaraciones.module';
import { Fase2Module } from './fase2/fase2.module';
import { Fase3Module } from './fase3/fase3.module';
import { SireModule } from './sire/sire.module';
import { SunafilModule } from './sunafil/sunafil.module';
import { BuzonSunatModule } from './buzon/buzon-sunat.module';

@Module({
  imports: [EmpresasModule, DeclaracionesModule, Fase2Module, Fase3Module, SireModule, SunafilModule, BuzonSunatModule],
  exports: [EmpresasModule, DeclaracionesModule, Fase2Module, Fase3Module, SireModule, SunafilModule, BuzonSunatModule],
})
export class VencimientosModule {}

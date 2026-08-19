import { Module } from '@nestjs/common';
import { EmpresasModule } from './empresas/empresas.module';
import { DeclaracionesModule } from './declaraciones/declaraciones.module';
import { Fase2Module } from './fase2/fase2.module';
import { Fase3Module } from './fase3/fase3.module';
import { SireModule } from './sire/sire.module';

@Module({
  imports: [EmpresasModule, DeclaracionesModule, Fase2Module, Fase3Module, SireModule],
  exports: [EmpresasModule, DeclaracionesModule, Fase2Module, Fase3Module, SireModule],
})
export class VencimientosModule {}

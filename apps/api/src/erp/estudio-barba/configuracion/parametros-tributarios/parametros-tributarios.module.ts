import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { ParametrosTributariosController } from './parametros-tributarios.controller';
import { ParametrosTributariosService } from './parametros-tributarios.service';

/**
 * Antes vivía declarado dentro del módulo de los asistentes de IA (el viejo
 * `fase3.module.ts`), solo porque se construyó en la misma etapa. No es IA:
 * es el catálogo de cifras oficiales (UIT, RMV, tasas) que los asistentes
 * consultan para no inventar números. Por eso ahora es configuración y tiene
 * su propio módulo, igual que guias-sunat.
 */
@Module({
  imports: [CommonModule],
  controllers: [ParametrosTributariosController],
  providers: [ParametrosTributariosService],
  exports: [ParametrosTributariosService],
})
export class ParametrosTributariosModule {}

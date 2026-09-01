import { Module } from '@nestjs/common';
import { ConceptosModule } from './conceptos/conceptos.module';
import { ConfiguracionModule } from './configuracion/configuracion.module';
import { TrabajadoresModule } from './trabajadores/trabajadores.module';
import { PlanillasModule } from './planillas/planillas.module';
import { BeneficiosModule } from './beneficios/beneficios.module';

/**
 * Módulo Planilla — sueldos, CTS y gratificaciones (ver bd/PLAN_MODULO_PLANILLAS.md).
 *
 * Paso 1: catálogos oficiales de SUNAT (conceptos del PDT PLAME).
 * Los siguientes pasos (trabajadores, planilla mensual, tareo, beneficios sociales,
 * archivos planos) se agregan acá como submódulos hermanos.
 */
@Module({
  imports: [ConceptosModule, ConfiguracionModule, TrabajadoresModule, PlanillasModule, BeneficiosModule],
  exports: [ConceptosModule, ConfiguracionModule, TrabajadoresModule, PlanillasModule, BeneficiosModule],
})
export class PlanillaModule {}

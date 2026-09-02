import { Module } from '@nestjs/common';
import { ConceptosModule } from './conceptos/conceptos.module';
import { ConfiguracionModule } from './configuracion/configuracion.module';
import { TrabajadoresModule } from './trabajadores/trabajadores.module';
import { PlanillasModule } from './planillas/planillas.module';
import { BeneficiosModule } from './beneficios/beneficios.module';
import { ContratosModule } from './contratos/contratos.module';

/**
 * Módulo Planilla — sueldos, CTS y gratificaciones (ver bd/PLAN_MODULO_PLANILLAS.md).
 *
 * Paso 1: catálogos oficiales de SUNAT (conceptos del PDT PLAME).
 * Los siguientes pasos (trabajadores, planilla mensual, tareo, beneficios sociales,
 * archivos planos) se agregan acá como submódulos hermanos.
 *
 * `ContratosModule` es el legajo documental: el estudio sube el PDF firmado de cada
 * contrato y el portal cliente lo descarga (ver `erp/cliente/`).
 */
@Module({
  imports: [ConceptosModule, ConfiguracionModule, TrabajadoresModule, PlanillasModule, BeneficiosModule, ContratosModule],
  exports: [ConceptosModule, ConfiguracionModule, TrabajadoresModule, PlanillasModule, BeneficiosModule, ContratosModule],
})
export class PlanillaModule {}

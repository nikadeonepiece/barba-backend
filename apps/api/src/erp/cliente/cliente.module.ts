import { Module } from '@nestjs/common';
import { PersonalClienteModule } from './personal/personal.module';
import { PlanillasClienteModule } from './planillas/planillas-cliente.module';

/**
 * Área CLIENTE — "Planillas Cliente", el portal que ve la empresa.
 *
 * Es el reverso del resto del ERP: en `erp/planilla`, `erp/vencimientos` y
 * `erp/catalogos` el usuario es del estudio y trabaja sobre las 171 empresas eligiendo
 * cuál. Acá el usuario ES una empresa y solo existe la suya — el alcance no se elige,
 * sale de `sis_usuario.id_empresa` a través del JWT (ver `scope-empresa.ts`).
 *
 * Todo el área es de SOLO LECTURA. Ningún endpoint escribe.
 *
 * Se registra como área propia en `api.module.ts` en vez de colgar de `PlanillaModule`
 * para que la separación sea física y no una convención: un módulo del portal no puede
 * terminar reusando por descuido un service del estudio que no filtra por empresa.
 */
@Module({
  imports: [PersonalClienteModule, PlanillasClienteModule],
  exports: [PersonalClienteModule, PlanillasClienteModule],
})
export class ClienteModule {}

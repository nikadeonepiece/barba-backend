import { Module } from '@nestjs/common';
import { PersonalClienteModule } from './personal/personal.module';
import { PlanillasClienteModule } from './planillas/planillas-cliente.module';
import { AsistenciaClienteModule } from './asistencia/asistencia.module';
import { ModalidadPagoClienteModule } from './modalidad-pago/modalidad-pago.module';
import { CajasClienteModule } from './cajas/cajas-cliente.module';
import { TableroClienteModule } from './tablero/tablero-cliente.module';
import { SireClienteModule } from './sire/sire-cliente.module';

/**
 * Área CLIENTE — "Planillas Cliente", el portal que ve la empresa.
 *
 * Es el reverso del resto del ERP: en `erp/planilla`, `erp/vencimientos` y
 * `erp/catalogos` el usuario es del estudio y trabaja sobre las 171 empresas eligiendo
 * cuál. Acá el usuario ES una empresa y solo existe la suya — el alcance no se elige,
 * sale de `sis_usuario.id_empresa` a través del JWT (ver `scope-empresa.ts`).
 *
 * ── Qué se puede escribir desde el portal (y qué no) ──
 *
 * El área NACIÓ de solo lectura y en su mayor parte lo sigue siendo: `personal`,
 * `planillas`, `sire` y `tablero` no tienen un solo POST/PUT/DELETE, porque quien da de
 * alta trabajadores, carga contratos, calcula planillas y baja los libros de SUNAT es el
 * estudio. `tablero` además no puede tenerlos nunca: solo agrega lo que ya cargaron las
 * otras pantallas.
 *
 * Las excepciones son `asistencia`, `modalidad-pago` y `cajas`, y son excepciones por
 * un motivo concreto: son datos que la empresa conoce de primera mano y el estudio no.
 * Quién vino a trabajar el martes, si Fulano cobra por mes o por jornal y en qué se
 * gastó la caja chica hoy viajan por WhatsApp; capturarlos en origen es la razón de ser
 * del portal.
 *
 * El límite de lo que el cliente puede tocar sigue siendo el mismo y hay que
 * respetarlo al agregar módulos: NADA que sea un monto, un cálculo o un estado de
 * planilla. Si un módulo nuevo del portal necesita escribir un importe, la respuesta
 * casi siempre es que va en la intranet.
 *
 * ── `cajas` y el "casi" de esa regla ──
 *
 * `cajas` SÍ escribe un importe, y es la única que lo hace. Se admitió porque el monto
 * no entra a contabilidad solo: el gasto que carga el cliente nace `POR_REVISAR`, se ve
 * en su estado de cuenta pero NO descuenta del saldo hasta que alguien del estudio lo
 * aprueba desde `tesoreria/cajas`. El cliente tampoco puede cargar INGRESOS (reponer el
 * fondo es del estudio) ni aprobar.
 *
 * Ese es el molde para la próxima excepción: si un módulo del portal necesita escribir
 * plata, va con un paso de revisión del estudio, o no va.
 *
 * Se registra como área propia en `api.module.ts` en vez de colgar de `PlanillaModule`
 * para que la separación sea física y no una convención: un módulo del portal no puede
 * terminar reusando por descuido un service del estudio que no filtra por empresa.
 */
@Module({
  imports: [
    PersonalClienteModule,
    PlanillasClienteModule,
    AsistenciaClienteModule,
    ModalidadPagoClienteModule,
    CajasClienteModule,
    TableroClienteModule,
    SireClienteModule,
  ],
  exports: [
    PersonalClienteModule,
    PlanillasClienteModule,
    AsistenciaClienteModule,
    ModalidadPagoClienteModule,
    CajasClienteModule,
    TableroClienteModule,
    SireClienteModule,
  ],
})
export class ClienteModule {}

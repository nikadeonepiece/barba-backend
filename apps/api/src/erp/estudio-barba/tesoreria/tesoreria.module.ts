import { Module } from '@nestjs/common';
import { CajasModule } from './cajas/cajas.module';
import { CuentasModule } from './cuentas/cuentas.module';
import { MovimientosModule } from './movimientos/movimientos.module';

/**
 * Módulo Tesorería — la plata de cada empresa cliente (ver la sección 7 de `bd.sql`).
 *
 * Hoy tiene CAJAS (caja chica: fondo que se abre, se gasta y se cierra), CUENTAS
 * bancarias y su libro de MOVIMIENTOS. Las pantallas que el esquema ya contempla y
 * todavía no tienen código —terceros, cuentas por cobrar y por pagar— se agregan acá
 * como submódulos hermanos, no en `ApiModule`.
 *
 * Todas comparten el mismo `sis_modulo` ('TESORERIA'): es la misma plata y el mismo
 * usuario, partirlo en dos módulos de permisos solo obligaría a asignar el doble.
 *
 * ⚠️ Caja chica y cuenta bancaria llevan saldo cada una con su propio archivo
 * (`cajas/cajas-saldos.ts` y `movimientos/cuentas-saldos.ts`). Son parecidos a
 * propósito y NO se unificaron: una caja chica no puede quedar en negativo nunca, una
 * cuenta bancaria sí (un sobregiro existe), y mezclar las dos reglas en una función
 * termina relajando la de la caja.
 */
@Module({
  imports: [CajasModule, CuentasModule, MovimientosModule],
  exports: [CajasModule, CuentasModule, MovimientosModule],
})
export class TesoreriaModule {}

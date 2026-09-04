import { Module } from '@nestjs/common';
import { CajasModule } from './cajas/cajas.module';

/**
 * Módulo Tesorería — la plata de cada empresa cliente (ver la sección 7 de `bd.sql`).
 *
 * Hoy solo tiene CAJAS (caja chica: fondo que se abre, se gasta y se cierra). Las
 * pantallas que el esquema ya contempla y todavía no tienen código — cuentas
 * bancarias, terceros, cuentas por cobrar y por pagar — se agregan acá como
 * submódulos hermanos, no en `ApiModule`.
 *
 * Todas comparten el mismo `sis_modulo` ('TESORERIA'): es la misma plata y el mismo
 * usuario, partirlo en dos módulos de permisos solo obligaría a asignar el doble.
 */
@Module({
  imports: [CajasModule],
  exports: [CajasModule],
})
export class TesoreriaModule {}

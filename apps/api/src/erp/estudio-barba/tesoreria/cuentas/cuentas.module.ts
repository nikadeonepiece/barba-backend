import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { CuentasController } from './cuentas.controller';
import { CuentasService } from './cuentas.service';

/**
 * `MovimientosModule` NO se importa por su service: el saldo vive en
 * `movimientos/cuentas-saldos.ts`, que son funciones sueltas y no un provider. Se
 * importa por `CommonModule` solamente; la dependencia real es el archivo compartido,
 * igual que `cajas-saldos.ts` en el módulo de cajas.
 */
@Module({
  imports: [CommonModule],
  controllers: [CuentasController],
  providers: [CuentasService],
  exports: [CuentasService],
})
export class CuentasModule {}

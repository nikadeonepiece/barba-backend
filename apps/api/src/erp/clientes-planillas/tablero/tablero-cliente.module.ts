import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { TableroClienteController } from './tablero-cliente.controller';
import { TableroClienteService } from './tablero-cliente.service';

/**
 * No importa ningún módulo de negocio: el tablero consulta las tablas directamente con
 * sus propias queries agregadas y acotadas por empresa.
 *
 * Reusar `PersonalClienteService` o `CajasClienteService` sería tentador y equivocado:
 * los dos devuelven listados paginados pensados para una grilla, así que el tablero
 * tendría que traerse las 300 filas del padrón para contar seis números. Lo que SÍ se
 * comparte es la definición de "cuenta para el saldo" (`cajas-saldos.ts`), porque dos
 * implementaciones de cuánto queda en la caja es cómo el tablero y el estado de cuenta
 * terminan mostrando plata distinta.
 *
 * `CommonModule` va por la convención del proyecto (todo módulo del área lo importa) y
 * para que agregar un export a PDF más adelante no exija tocar el módulo.
 */
@Module({
  imports: [CommonModule],
  controllers: [TableroClienteController],
  providers: [TableroClienteService],
  exports: [TableroClienteService],
})
export class TableroClienteModule {}

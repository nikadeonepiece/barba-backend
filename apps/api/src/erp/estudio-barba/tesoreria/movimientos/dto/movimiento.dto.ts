import {
  IsDateString, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PartialType } from '@nestjs/mapped-types';

export const TIPOS_MOVIMIENTO = ['INGRESO', 'EGRESO'] as const;
export const MONEDAS = ['PEN', 'USD'] as const;
export const ESTADOS_FLUJO = ['POR_REVISAR', 'PENDIENTE', 'CONCILIADO'] as const;

export class CreateMovimientoDto {
  @IsInt() @Min(1) @Type(() => Number) id_cuenta: number;

  @IsIn(TIPOS_MOVIMIENTO as unknown as string[]) tipo: string;

  @IsDateString({}, { message: 'La fecha no tiene un formato válido' }) fecha: string;

  // `maxDecimalPlaces: 2` además del `Min`: un monto con seis decimales entra en la
  // columna DECIMAL(14,2) redondeado y el total deja de cuadrar contra el banco.
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01, { message: 'El monto debe ser mayor que cero' }) @Type(() => Number)
  monto: number;

  @IsOptional() @IsIn(MONEDAS as unknown as string[]) moneda?: string;

  // Solo si la moneda del movimiento no es la de la cuenta. Lo valida el service.
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Type(() => Number) tipo_cambio?: number;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_tercero?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_medio_pago?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_centro_costo_concepto?: number;

  @IsOptional() @IsString() @MaxLength(500) descripcion?: string;
  @IsOptional() @IsString() @MaxLength(30) tipo_comprobante?: string;
  @IsOptional() @IsString() @MaxLength(50) serie_numero?: string;

  // Las llena el endpoint de subida, no el formulario.
  @IsOptional() @IsString() @MaxLength(500) ruta_comprobante?: string;

  @IsOptional() @IsIn(ESTADOS_FLUJO as unknown as string[]) estado_flujo?: string;
}

export class UpdateMovimientoDto extends PartialType(CreateMovimientoDto) {}

/**
 * Transferencia entre dos cuentas propias.
 *
 * DTO propio y no `CreateMovimientoDto` con dos cuentas: el resultado son DOS
 * movimientos atados, y el formulario pide cosas que un movimiento suelto no tiene
 * (cuenta destino) y no pide otras que no aplican (tipo, que siempre es egreso en la
 * de origen e ingreso en la de destino).
 */
export class TransferenciaDto {
  @IsInt() @Min(1) @Type(() => Number) id_cuenta_origen: number;
  @IsInt() @Min(1) @Type(() => Number) id_cuenta_destino: number;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Type(() => Number) monto: number;

  // Solo hace falta cuando las dos cuentas están en monedas distintas: es a cuánto se
  // convirtió. Sin él, el monto que sale de una no es el que entra en la otra.
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Type(() => Number) tipo_cambio?: number;

  // Cuánto entra realmente en la cuenta destino. Si las monedas coinciden es el mismo
  // monto; si no, el convertido. Se pide explícito en vez de calcularlo para que el
  // número que queda registrado sea el que el banco muestra, con su redondeo.
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Type(() => Number) monto_destino?: number;

  @IsDateString() fecha: string;
  @IsOptional() @IsString() @MaxLength(500) descripcion?: string;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_medio_pago?: number;
}

export class AnularMovimientoDto {
  @IsNotEmpty({ message: 'El motivo de la anulación es obligatorio' })
  @IsString() @MaxLength(255) motivo_anulacion: string;
}

export class CambiarEstadoFlujoDto {
  @IsIn(ESTADOS_FLUJO as unknown as string[]) estado_flujo: string;
}

/** Query del listado — validada para que un `limit=999999` no baje la base entera. */
export class ListarMovimientosQueryDto {
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) @Type(() => Number) limit?: number;
  @IsOptional() @IsString() search?: string;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_empresa?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_cuenta?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_banco?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_tercero?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_medio_pago?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_centro_costo_concepto?: number;

  @IsOptional() @IsIn(TIPOS_MOVIMIENTO as unknown as string[]) tipo?: string;
  @IsOptional() @IsIn(ESTADOS_FLUJO as unknown as string[]) estado_flujo?: string;
  @IsOptional() @IsIn(['REGISTRADO', 'ANULADO']) estado?: string;

  @IsOptional() @IsDateString() fecha_desde?: string;
  @IsOptional() @IsDateString() fecha_hasta?: string;

  @IsOptional() @IsString() sortCol?: string;
  @IsOptional() @IsIn(['ASC', 'DESC']) sortDir?: 'ASC' | 'DESC';
}

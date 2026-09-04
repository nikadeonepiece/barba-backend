import {
  IsString, IsNotEmpty, IsOptional, IsInt, IsNumber, IsIn, Min, MaxLength, IsDateString, ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export const MEDIOS_PAGO = ['EFECTIVO', 'TRANSFERENCIA', 'DEPOSITO', 'YAPE_PLIN', 'TARJETA', 'OTRO'] as const;
export const TIPOS_COMPROBANTE = ['FACTURA', 'BOLETA', 'RECIBO', 'TICKET', 'VOUCHER', 'NINGUNO'] as const;
export const TIPOS_MOVIMIENTO = ['INGRESO', 'EGRESO'] as const;

/**
 * Apertura de una caja chica para una empresa cliente.
 *
 * `monto_inicial` admite 0: hay cajas que se abren sin fondo y se cargan con la
 * primera reposición. Lo que no admite es negativo — una caja no nace debiendo.
 */
export class CreateCajaDto {
  @IsInt() @Min(1) @Type(() => Number)
  id_empresa!: number;

  @IsString() @IsNotEmpty() @MaxLength(120)
  nombre!: string;

  @IsOptional() @IsString() @MaxLength(150)
  responsable?: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Type(() => Number)
  monto_inicial!: number;

  @IsDateString()
  fecha_apertura!: string;

  @IsOptional() @IsString() @MaxLength(500)
  observaciones?: string;
}

/**
 * Reemplazo completo de la cabecera de una caja abierta.
 *
 * NO extiende `PartialType(CreateCajaDto)` a propósito: `id_empresa` queda fuera del
 * contrato. Cambiar de empresa no es corregir una caja — es otra caja, y los
 * movimientos ya registrados quedarían atribuidos a un cliente que no es. Para eso
 * se cierra esta y se abre la de la empresa correcta.
 *
 * `monto_inicial` sí se puede corregir (se tipeó mal el fondo entregado): el service
 * aplica la DIFERENCIA al saldo, no lo recalcula desde cero.
 */
export class UpdateCajaDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  nombre!: string;

  @IsOptional() @IsString() @MaxLength(150)
  responsable?: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Type(() => Number)
  monto_inicial!: number;

  @IsDateString()
  fecha_apertura!: string;

  @IsOptional() @IsString() @MaxLength(500)
  observaciones?: string;
}

export class CreateMovimientoCajaDto {
  @IsInt() @Min(1) @Type(() => Number)
  id_caja!: number;

  @IsIn(TIPOS_MOVIMIENTO as unknown as string[])
  tipo!: string;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number)
  id_caja_concepto?: number;

  // Un movimiento de 0 no mueve plata ni deja rastro útil; el mínimo real es el céntimo.
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Type(() => Number)
  monto!: number;

  @IsDateString()
  fecha!: string;

  @IsOptional() @IsIn(MEDIOS_PAGO as unknown as string[])
  medio_pago?: string;

  @IsOptional() @IsString() @MaxLength(500)
  descripcion?: string;

  @IsOptional() @IsIn(TIPOS_COMPROBANTE as unknown as string[])
  tipo_comprobante?: string;

  @IsOptional() @IsString() @MaxLength(50)
  nro_comprobante?: string;

  // Las devuelve `POST tesoreria/cajas/comprobante` (paso 1 de la carga). Se mandan
  // tal cual: el service no confía en ellas para tocar el disco, solo las guarda.
  @IsOptional() @IsString() @MaxLength(500)
  ruta_comprobante?: string;

  @IsOptional() @IsString() @MaxLength(255)
  nombre_comprobante?: string;
}

/**
 * Corrección de un movimiento ya registrado.
 *
 * `id_caja` y `tipo` quedan fuera: mover un movimiento a otra caja o convertir un
 * gasto en ingreso descuadra los dos saldos involucrados. Para eso se anula y se
 * registra de nuevo, que además deja el rastro de por qué.
 */
export class UpdateMovimientoCajaDto {
  @IsOptional() @IsInt() @Min(1) @Type(() => Number)
  id_caja_concepto?: number;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Type(() => Number)
  monto!: number;

  @IsDateString()
  fecha!: string;

  @IsOptional() @IsIn(MEDIOS_PAGO as unknown as string[])
  medio_pago?: string;

  @IsOptional() @IsString() @MaxLength(500)
  descripcion?: string;

  @IsOptional() @IsIn(TIPOS_COMPROBANTE as unknown as string[])
  tipo_comprobante?: string;

  @IsOptional() @IsString() @MaxLength(50)
  nro_comprobante?: string;

  @IsOptional() @IsString() @MaxLength(500)
  ruta_comprobante?: string;

  @IsOptional() @IsString() @MaxLength(255)
  nombre_comprobante?: string;
}

/**
 * El motivo es OBLIGATORIO: una anulación sin explicación deja el arqueo con un
 * agujero que nadie puede justificar seis meses después.
 */
export class AnularMovimientoCajaDto {
  @IsString() @IsNotEmpty() @MaxLength(255)
  motivo!: string;
}

/**
 * Revisión de un gasto cargado desde el PORTAL CLIENTE.
 *
 * `RECHAZADO` exige motivo y `APROBADO` no lo acepta: el motivo es lo único que le dice
 * al cliente qué corregir, y un "aprobado porque sí" solo ensucia el registro. El
 * `@ValidateIf` es lo que hace que la regla la aplique el DTO y no el service — sin él,
 * un rechazo sin motivo llegaría hasta la query y reventaría con un 500 genérico.
 */
export class RevisarMovimientoCajaDto {
  @IsIn(['APROBADO', 'RECHAZADO'])
  decision!: string;

  @ValidateIf((o) => o.decision === 'RECHAZADO')
  @IsString() @IsNotEmpty({ message: 'Al rechazar un gasto hay que decir por qué' }) @MaxLength(255)
  motivo?: string;
}

import {
  IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PartialType } from '@nestjs/mapped-types';

export const TIPOS_CUENTA = ['CORRIENTE', 'AHORROS', 'DETRACCIONES', 'EFECTIVO', 'OTRO'] as const;
export const MONEDAS = ['PEN', 'USD'] as const;

export class CreateCuentaDto {
  @IsInt() @Min(1) @Type(() => Number) id_empresa: number;

  // NULL = caja en efectivo, que no tiene banco. Por eso es opcional y no un FK exigido.
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_banco?: number;

  @IsIn(TIPOS_CUENTA as unknown as string[]) tipo: string;
  @IsIn(MONEDAS as unknown as string[]) moneda: string;

  @IsOptional() @IsString() @MaxLength(30) numero_cuenta?: string;
  @IsOptional() @IsString() @MaxLength(25) cci?: string;

  @IsNotEmpty({ message: 'El alias es obligatorio: es como se elige la cuenta en los desplegables' })
  @IsString() @MaxLength(100) alias: string;

  // El saldo con el que la cuenta entra al sistema. Puede ser negativo: una cuenta
  // sobregirada existe, y forzarla a cero al darla de alta la haría arrancar mintiendo.
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Type(() => Number) saldo_inicial?: number;

  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
}

export class UpdateCuentaDto extends PartialType(CreateCuentaDto) {}

export class ListarCuentasQueryDto {
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) @Type(() => Number) limit?: number;
  @IsOptional() @IsString() search?: string;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_empresa?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_banco?: number;
  @IsOptional() @IsIn(TIPOS_CUENTA as unknown as string[]) tipo?: string;
  @IsOptional() @IsIn(MONEDAS as unknown as string[]) moneda?: string;

  @IsOptional() @IsString() sortCol?: string;
  @IsOptional() @IsIn(['ASC', 'DESC']) sortDir?: 'ASC' | 'DESC';
}

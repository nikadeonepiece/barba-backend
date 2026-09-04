import { IsInt, Min, Max, IsOptional, IsIn, IsString, MaxLength, IsNumber, IsDateString } from 'class-validator';

export class CreateBeneficioDto {
  @IsInt() @Min(1) id_empresa!: number;

  @IsIn(['CTS', 'GRATIFICACION', 'VACACIONES', 'LIQUIDACION'])
  tipo!: string;

  @IsInt() @Min(2000) @Max(2100) anio!: number;

  // 1 o 2. En CTS el semestre 1 es nov→abr y el 2 may→oct; en gratificación,
  // 1 es ene→jun y 2 jul→dic. En liquidaciones no aplica.
  @IsOptional() @IsInt() @Min(1) @Max(2) semestre?: number;

  // Sobrescriben el periodo legal. Hacen falta en una liquidación por cese a mitad
  // de semestre, donde el periodo no coincide con el de ley.
  @IsOptional() @IsDateString() periodo_desde?: string;
  @IsOptional() @IsDateString() periodo_hasta?: string;

  @IsOptional() @IsDateString() fecha_pago_legal?: string;
  @IsOptional() @IsDateString() fecha_pago_real?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(200) tea_interes?: number;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
}

/** Cambia lo que gatilla el interés por mora: cuándo se pagó y a qué tasa. */
export class ActualizarPagoDto {
  @IsOptional() @IsDateString() fecha_pago_real?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(200) tea_interes?: number;
}

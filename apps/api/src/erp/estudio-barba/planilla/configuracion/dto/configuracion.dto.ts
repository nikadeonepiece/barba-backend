import {
  IsString, IsNotEmpty, MaxLength, IsOptional, IsIn, IsInt, IsNumber,
  Min, Max, IsBoolean, IsDateString, Matches,
} from 'class-validator';

/** Régimen laboral — solo se editan los factores; el código no cambia nunca. */
export class UpdateRegimenDto {
  @IsOptional() @IsString() @MaxLength(120) nombre?: string;
  @IsOptional() @IsInt() @Min(0) @Max(31) dias_vacaciones?: number;

  // 1.00 general · 0.50 pequeña · 0.00 micro. Se topa en 1 porque no existe régimen
  // que pague más de una remuneración completa por semestre.
  @IsOptional() @IsNumber() @Min(0) @Max(1) factor_gratificacion?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) factor_cts?: number;

  @IsOptional() @IsBoolean() aplica_asignacion_familiar?: boolean;
  @IsOptional() @IsBoolean() aplica_essalud?: boolean;
  @IsOptional() @IsBoolean() pension_obligatoria?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(365) dias_indemnizacion_por_anio?: number;
  @IsOptional() @IsInt() @Min(0) @Max(3650) tope_dias_indemnizacion?: number;
  @IsOptional() @IsString() @MaxLength(255) base_legal?: string;
}

/**
 * Tasa de AFP. `vigencia_desde` es obligatoria al crear porque la SBS las cambia
 * cada cuatrimestre: sin fecha, recalcular una planilla vieja usaría la tasa nueva
 * y daría un resultado distinto al que se declaró.
 */
export class CreateAfpTasaDto {
  @IsInt() @Min(1) id_afp!: number;
  @IsDateString() vigencia_desde!: string;

  @IsOptional() @IsDateString() vigencia_hasta?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_aporte_obligatorio?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_comision_flujo?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_comision_mixta_flujo?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_comision_mixta_saldo?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_prima_seguro?: number;
  @IsOptional() @IsNumber() @Min(0) tope_remuneracion_asegurable?: number;

  // Marcarlo como verificado es una afirmación sobre la realidad: alguien miró la SBS.
  @IsOptional() @IsBoolean() verificado?: boolean;
  @IsOptional() @IsString() @MaxLength(255) fuente?: string;
}

export class UpdateAfpTasaDto {
  @IsOptional() @IsDateString() vigencia_desde?: string;
  @IsOptional() @IsDateString() vigencia_hasta?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_aporte_obligatorio?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_comision_flujo?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_comision_mixta_flujo?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_comision_mixta_saldo?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_prima_seguro?: number;
  @IsOptional() @IsNumber() @Min(0) tope_remuneracion_asegurable?: number;
  @IsOptional() @IsBoolean() verificado?: boolean;
  @IsOptional() @IsString() @MaxLength(255) fuente?: string;
}

export class CreateParametroDto {
  @IsString() @IsNotEmpty() @MaxLength(60)
  @Matches(/^[A-Z0-9_]+$/, { message: 'El código debe ir en MAYÚSCULAS con guiones bajos (ej. RMV, ESSALUD_PCT)' })
  codigo!: string;

  @IsString() @IsNotEmpty() @MaxLength(200) nombre!: string;
  @IsNumber() @Min(0) valor!: number;
  @IsIn(['SOLES', 'PORCENTAJE', 'DIAS', 'FACTOR']) unidad!: string;
  @IsDateString() vigencia_desde!: string;

  @IsOptional() @IsDateString() vigencia_hasta?: string;
  @IsOptional() @IsString() @MaxLength(255) base_legal?: string;
  @IsOptional() @IsBoolean() verificado?: boolean;
  @IsOptional() @IsString() @MaxLength(255) fuente?: string;
}

export class UpdateParametroDto {
  @IsOptional() @IsString() @MaxLength(200) nombre?: string;
  @IsOptional() @IsNumber() @Min(0) valor?: number;
  @IsOptional() @IsIn(['SOLES', 'PORCENTAJE', 'DIAS', 'FACTOR']) unidad?: string;
  @IsOptional() @IsDateString() vigencia_desde?: string;
  @IsOptional() @IsDateString() vigencia_hasta?: string;
  @IsOptional() @IsString() @MaxLength(255) base_legal?: string;
  @IsOptional() @IsBoolean() verificado?: boolean;
  @IsOptional() @IsString() @MaxLength(255) fuente?: string;
}

export class UpdateEscalaDto {
  @IsOptional() @IsNumber() @Min(0) uit_desde?: number;
  @IsOptional() @IsNumber() @Min(0) uit_hasta?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) tasa?: number;
  @IsOptional() @IsString() @MaxLength(255) base_legal?: string;
  @IsOptional() @IsBoolean() verificado?: boolean;
}

export class UpdateBancoDto {
  @IsOptional() @IsString() @MaxLength(150) nombre?: string;
  @IsOptional() @IsIn(['BCP', 'INTERBANK', 'BBVA', 'SCOTIABANK', 'NINGUNO']) formato_telecredito?: string;
  @IsOptional() @IsInt() @Min(0) @Max(30) longitud_cuenta?: number;
  @IsOptional() @IsInt() @Min(0) @Max(30) longitud_cci?: number;
}

export class CreateTareoMarcaDto {
  @IsString() @IsNotEmpty() @MaxLength(5) codigo!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) nombre!: string;

  @IsOptional() @IsBoolean() computa_dia_laborado?: boolean;
  @IsOptional() @IsBoolean() computa_falta?: boolean;
  @IsOptional() @IsBoolean() computa_feriado?: boolean;
  @IsOptional() @IsBoolean() computa_descanso?: boolean;
  @IsOptional() @IsBoolean() computa_subsidio?: boolean;
  @IsOptional() @IsBoolean() computa_vacaciones?: boolean;
  @IsOptional() @IsBoolean() computa_licencia_con_goce?: boolean;
  @IsOptional() @IsBoolean() computa_licencia_sin_goce?: boolean;
  @IsOptional() @IsBoolean() es_computable_beneficios?: boolean;

  @IsOptional() @IsString() @MaxLength(10) cod_tipo_suspension_sunat?: string;
  @IsOptional() @IsString() @MaxLength(7) color_hex?: string;
  @IsOptional() @IsInt() @Min(0) orden?: number;
}

export class UpdateTareoMarcaDto extends CreateTareoMarcaDto {
  @IsOptional() @IsString() @MaxLength(5) declare codigo: string;
  @IsOptional() @IsString() @MaxLength(120) declare nombre: string;
}

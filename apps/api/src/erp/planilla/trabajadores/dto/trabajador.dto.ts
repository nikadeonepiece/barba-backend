import {
  IsString, IsNotEmpty, MaxLength, IsOptional, IsIn, IsInt, IsNumber,
  Min, Max, IsBoolean, IsDateString, IsEmail,
} from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';

export class CreateTrabajadorDto {
  @IsInt() @Min(1) id_empresa!: number;

  // --- Identificación ---
  @IsOptional() @IsString() @MaxLength(10) cod_tipo_documento?: string;

  @IsString() @IsNotEmpty() @MaxLength(15) numero_documento!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) apellido_paterno!: string;
  @IsOptional() @IsString() @MaxLength(60) apellido_materno?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) nombres!: string;

  @IsOptional() @IsDateString() fecha_nacimiento?: string;
  @IsOptional() @IsIn(['M', 'F']) sexo?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_nacionalidad?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_ubigeo?: string;
  @IsOptional() @IsString() @MaxLength(255) direccion?: string;
  @IsOptional() @IsEmail({}, { message: 'El correo no tiene un formato válido' }) @MaxLength(120) email?: string;
  @IsOptional() @IsString() @MaxLength(30) telefono?: string;

  // --- Situación laboral ---
  // El régimen de CÁLCULO (MTPE). No confundir con cod_regimen_laboral_sunat, que
  // es lo que se declara en el T-Registro: son datos distintos y ambos hacen falta.
  @IsInt() @Min(1) id_regimen!: number;

  @IsOptional() @IsString() @MaxLength(10) cod_regimen_laboral_sunat?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_tipo_trabajador?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_categoria_ocupacional?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_tipo_contrato?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_ocupacion?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_periodicidad?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_situacion?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_motivo_fin_periodo?: string;
  @IsOptional() @IsString() @MaxLength(120) cargo?: string;
  @IsOptional() @IsString() @MaxLength(120) area?: string;

  @IsDateString() fecha_ingreso!: string;
  @IsOptional() @IsDateString() fecha_cese?: string;

  // --- Condiciones que cambian el cálculo ---
  @IsOptional() @IsBoolean() jornada_maxima?: boolean;
  @IsOptional() @IsBoolean() sujeto_fiscalizacion?: boolean;
  @IsOptional() @IsBoolean() discapacidad?: boolean;
  @IsOptional() @IsBoolean() sindicalizado?: boolean;
  @IsOptional() @IsBoolean() tiene_hijos_menores?: boolean;

  // --- Previsional y salud ---
  @IsOptional() @IsIn(['ONP', 'AFP', 'SIN_REGIMEN']) regimen_pensionario?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_regimen_pensionario_sunat?: string;
  @IsOptional() @IsInt() @Min(1) id_afp?: number;
  @IsOptional() @IsString() @MaxLength(20) cuspp?: string;
  @IsOptional() @IsIn(['FLUJO', 'MIXTA']) tipo_comision_afp?: string;
  @IsOptional() @IsDateString() fecha_afiliacion_afp?: string;
  @IsOptional() @IsString() @MaxLength(10) cod_regimen_salud?: string;
  @IsOptional() @IsBoolean() afecto_sctr?: boolean;
  @IsOptional() @IsBoolean() essalud_vida?: boolean;

  // --- Pago ---
  @IsOptional() @IsInt() @Min(1) id_banco_sueldo?: number;
  @IsOptional() @IsString() @MaxLength(30) cuenta_sueldo?: string;
  @IsOptional() @IsString() @MaxLength(25) cci_sueldo?: string;
  @IsOptional() @IsInt() @Min(1) id_banco_cts?: number;
  @IsOptional() @IsString() @MaxLength(30) cuenta_cts?: string;
  @IsOptional() @IsString() @MaxLength(25) cci_cts?: string;

  @IsOptional() @IsString() observaciones?: string;

  // Sueldo de ingreso. Va en el alta para no obligar a un segundo paso: sin sueldo
  // el trabajador no sirve para calcular nada. Se guarda en el historial, no como
  // columna del trabajador.
  @IsNumber() @Min(0) sueldo_basico!: number;
}

export class UpdateTrabajadorDto extends PartialType(CreateTrabajadorDto) {}

/** Cese — se separa del update general porque cambia la situación declarable ante SUNAT. */
export class CesarTrabajadorDto {
  @IsDateString() fecha_cese!: string;

  @IsString() @IsNotEmpty() @MaxLength(10)
  cod_motivo_fin_periodo!: string; // Tabla 17

  @IsOptional() @IsString() @MaxLength(255) observacion?: string;
}

export class CreateRemuneracionDto {
  @IsDateString() vigencia_desde!: string;
  @IsNumber() @Min(0) sueldo_basico!: number;

  @IsOptional() @IsIn(['PEN', 'USD']) moneda?: string;
  @IsOptional() @IsIn(['INGRESO', 'AUMENTO', 'CAMBIO_CARGO', 'REDUCCION', 'AJUSTE']) motivo?: string;
  @IsOptional() @IsString() @MaxLength(255) observacion?: string;
}

export class CreateConceptoFijoDto {
  @IsInt() @Min(1) id_concepto!: number;
  @IsDateString() vigencia_desde!: string;

  @IsOptional() @IsNumber() @Min(0) monto?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) porcentaje?: number;
  @IsOptional() @IsDateString() vigencia_hasta?: string;
  @IsOptional() @IsInt() @Min(1) @Max(360) numero_cuotas?: number;
  @IsOptional() @IsNumber() @Min(0) saldo_pendiente?: number;
  @IsOptional() @IsString() @MaxLength(255) observacion?: string;
}

export class UpdateConceptoFijoDto extends PartialType(CreateConceptoFijoDto) {}

export class UpdateEmpresaConfigDto {
  @IsOptional() @IsInt() @Min(1) id_regimen_default?: number;
  @IsOptional() @IsString() @MaxLength(10) cod_regimen_salud?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_credito_eps?: number;

  @IsOptional() @IsBoolean() afecto_senati?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_senati?: number;

  @IsOptional() @IsBoolean() afecto_sctr?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(100) tasa_sctr_salud?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) tasa_sctr_pension?: number;

  @IsOptional() @IsNumber() @Min(1) @Max(24) horas_jornada?: number;
  @IsOptional() @IsInt() @Min(28) @Max(31) dias_mes?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct_adelanto_quincena?: number;

  @IsOptional() @IsInt() @Min(1) id_banco_haberes?: number;
  @IsOptional() @IsString() @MaxLength(30) cuenta_cargo_telecredito?: string;
  @IsOptional() @IsString() @MaxLength(10) codigo_establecimiento_sunat?: string;
}

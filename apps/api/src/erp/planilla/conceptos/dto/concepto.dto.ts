import { IsString, IsNotEmpty, MaxLength, IsOptional, IsIn, IsInt, Min, Max, IsBoolean, IsNumber, Matches } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';

/**
 * Alta de un concepto PROPIO del estudio, fuera de la Tabla 22 de SUNAT.
 *
 * Los 311 conceptos oficiales NO se crean por acá: entran por la semilla y por la
 * reimportación del archivo de SUNAT. Este DTO existe para el caso en que el
 * estudio necesite un concepto interno que SUNAT no contempla (SUNAT prevé eso con
 * el código 1000 "Otros conceptos").
 */
export class CreateConceptoDto {
  // Código PLAME de 4 dígitos. Se valida el formato, no contra un catálogo cerrado:
  // SUNAT agrega códigos y este módulo existe para no depender de un despliegue.
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}$/, { message: 'El código PLAME debe tener exactamente 4 dígitos' })
  codigo_plame!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nombre!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  grupo_sunat?: string;

  @IsIn(['INGRESO', 'DESCUENTO', 'APORTE_EMPLEADOR'])
  tipo!: string;

  // --- Afectaciones. En un concepto propio las define el estudio; en uno de SUNAT
  // vienen del archivo oficial y este endpoint no las toca (ver el service).
  @IsOptional() @IsBoolean() es_remunerativo?: boolean;
  @IsOptional() @IsBoolean() afecto_renta_quinta?: boolean;
  @IsOptional() @IsBoolean() afecto_essalud?: boolean;
  @IsOptional() @IsBoolean() afecto_sctr?: boolean;
  @IsOptional() @IsBoolean() afecto_senati?: boolean;
  @IsOptional() @IsBoolean() afecto_onp?: boolean;
  @IsOptional() @IsBoolean() afecto_afp?: boolean;
  @IsOptional() @IsBoolean() afecto_ies?: boolean;

  // --- Reglas laborales del MTPE. Las define el estudio SIEMPRE, incluso en los
  // conceptos de SUNAT: la Tabla 22 no dice qué entra a la base de CTS.
  @IsOptional() @IsBoolean() base_cts?: boolean;
  @IsOptional() @IsBoolean() base_gratificacion?: boolean;
  @IsOptional() @IsBoolean() base_vacaciones?: boolean;

  @IsOptional()
  @IsIn(['FIJO', 'PORCENTAJE', 'FORMULA', 'MANUAL'])
  tipo_calculo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  formula?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999)
  porcentaje_default?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  orden_impresion?: number;
}

export class UpdateConceptoDto extends PartialType(CreateConceptoDto) {}

/**
 * Edición de las reglas del estudio sobre un concepto OFICIAL de SUNAT.
 *
 * Deliberadamente NO incluye nombre, tipo ni las afectaciones: esas son de SUNAT y
 * la próxima reimportación las pisaría de vuelta. Permitir editarlas daría la
 * ilusión de que el cambio quedó guardado, y se perdería sin aviso.
 */
export class UpdateReglasConceptoDto {
  @IsOptional() @IsBoolean() base_cts?: boolean;
  @IsOptional() @IsBoolean() base_gratificacion?: boolean;
  @IsOptional() @IsBoolean() base_vacaciones?: boolean;

  @IsOptional()
  @IsIn(['FIJO', 'PORCENTAJE', 'FORMULA', 'MANUAL'])
  tipo_calculo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  formula?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999)
  porcentaje_default?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  orden_impresion?: number;
}

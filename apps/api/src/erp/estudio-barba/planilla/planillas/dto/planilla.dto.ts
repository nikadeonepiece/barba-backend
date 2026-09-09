import {
  IsInt, Min, Max, IsOptional, IsIn, IsString, MaxLength, IsNumber,
  IsArray, ValidateNested, IsDateString, IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePlanillaDto {
  @IsInt() @Min(1) id_empresa!: number;
  @IsInt() @Min(2000) @Max(2100) anio!: number;
  @IsInt() @Min(1) @Max(12) mes!: number;

  @IsOptional() @IsIn(['MENSUAL', 'ADICIONAL']) tipo?: string;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
}

export class CreateEntradaDatoDto {
  @IsInt() @Min(1) id_trabajador!: number;

  @IsIn(['ADELANTO_QUINCENA', 'INGRESO', 'DESCUENTO', 'VACACIONES', 'DIAS_NO_LABORADOS',
    'HORAS_EXTRAS', 'FERIADOS', 'RENTA_QUINTA', 'VIDA_LEY_SCTR', 'TAREO', 'IMPORTACION'])
  origen!: string;

  @IsOptional() @IsInt() @Min(1) id_concepto?: number;
  @IsOptional() @IsNumber() @Min(0) cantidad?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) porcentaje?: number;
  @IsOptional() @IsNumber() monto?: number;
  @IsOptional() @IsString() @MaxLength(255) observacion?: string;
}

/**
 * Un día del tareo.
 *
 * El @Type() del array de abajo no es decorativo: sin él, @ValidateNested no entra a
 * validar el interior de cada objeto y pasarían días con id_marca inexistente o
 * con 40 horas extras.
 */
export class DiaTareoDto {
  @IsInt() @Min(1) @Max(31) dia!: number;
  @IsInt() @Min(1) id_marca!: number;

  @IsOptional() @IsNumber() @Min(0) @Max(24) horas_extras_25?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(24) horas_extras_35?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1440) minutos_tardanza?: number;
}

export class GuardarTareoDto {
  @IsInt() @Min(1) id_trabajador!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DiaTareoDto)
  dias!: DiaTareoDto[];
}

/**
 * Paso 2 de la carga de una boleta firmada: los datos, ya con el PDF en disco.
 *
 * Se separa del `POST .../subir` (paso 1) por lo mismo que en contratos: en
 * `multipart/form-data` todos los campos llegan como string y `@IsInt()`/
 * `@IsDateString()` dejarían de validar nada.
 *
 * `id_planilla` NO va acá: viene del `:id` de la URL. Aceptarlo también en el body
 * dejaría dos fuentes para el mismo dato y la posibilidad de que no coincidan.
 */
export class RegistrarBoletaFirmadaDto {
  @IsInt() @Min(1) id_trabajador!: number;

  @IsString() @IsNotEmpty() @MaxLength(255) archivo_ruta!: string;
  @IsString() @IsNotEmpty() @MaxLength(255) archivo_nombre!: string;

  /** Cuándo firmó el trabajador — no cuándo se subió el escaneo. */
  @IsOptional() @IsDateString() fecha_entrega?: string;

  @IsOptional() @IsString() @MaxLength(255) observaciones?: string;
}

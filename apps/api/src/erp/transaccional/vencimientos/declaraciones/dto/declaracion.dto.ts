import { IsInt, IsIn, IsOptional, IsDateString, IsString, IsNumber, IsPositive, Min, Max, MaxLength } from 'class-validator';

export class MarcarDeclaracionDto {
  @IsInt() @IsPositive()
  id_empresa!: number;

  @IsInt()
  periodo_anio!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  periodo_mes!: number;

  // AFP_NET incluido: el controller acota además por área (solo el endpoint laboral lo acepta)
  @IsIn(['IGV_RENTA', 'PLANILLA', 'RCE_RVIE_SIRE', 'AFP_NET'])
  tipo_obligacion!: string;

  @IsDateString()
  fecha_declaracion!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  constancia_archivo?: string;
}

export class UpsertCronogramaDto {
  @IsInt()
  anio!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  mes!: number;

  @IsInt()
  @Min(0)
  @Max(9)
  digito_ruc!: number;

  @IsIn(['IGV_RENTA', 'PLANILLA', 'RCE_RVIE_SIRE', 'AFP_NET'])
  tipo_obligacion!: string;

  @IsDateString()
  fecha_limite!: string;
}

export class RegistrarSaldoFavorDto {
  @IsInt() @IsPositive()
  id_empresa!: number;

  @IsInt()
  periodo_anio!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  periodo_mes!: number;

  @IsIn(['IGV', 'RENTA', 'PERCEPCIONES', 'RETENCIONES'])
  tipo_impuesto!: string;

  @IsNumber() @Min(0)
  monto!: number;

  @IsIn(['DECLARACION_OFICIAL', 'CORTE_PRELIMINAR'])
  fuente!: string;
}

export class RegistrarCortePreliminarDto {
  @IsInt() @IsPositive()
  id_empresa!: number;

  @IsInt()
  periodo_anio!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  periodo_mes!: number;

  @IsNumber() @Min(0)
  total_compras!: number;

  @IsNumber() @Min(0)
  total_ventas!: number;

  @IsOptional()
  @IsNumber() @Min(0)
  compras_no_grabadas?: number;

  @IsNumber()
  resultado_igv!: number;
}

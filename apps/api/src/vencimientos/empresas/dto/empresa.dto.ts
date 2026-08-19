import { IsString, IsOptional, IsIn, IsInt, IsPositive, Matches, MaxLength } from 'class-validator';
import { PartialType, OmitType } from '@nestjs/mapped-types';

export class CreateEmpresaDto {
  @IsString()
  @MaxLength(200)
  razon_social!: string;

  // RUC peruano: 11 dígitos exactos, solo numérico — `@Length(11,11)` solo por sí sola
  // dejaba pasar cualquier string de 11 caracteres (letras incluidas).
  @IsString()
  @Matches(/^\d{11}$/, { message: 'ruc debe tener exactamente 11 dígitos numéricos' })
  ruc!: string;

  @IsIn(['MYPE', 'RER', 'NRUS', 'R.GENERAL'])
  regimen_tributario!: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  id_encargado_contable?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  id_encargado_laboral?: number;
}

// El RUC no se actualiza una vez creada la empresa (es la llave del cronograma) —
// se omite del PartialType en vez de heredarlo como opcional, para que ni siquiera
// sea un campo válido en el body de un PUT.
export class UpdateEmpresaDto extends PartialType(OmitType(CreateEmpresaDto, ['ruc'] as const)) {
  @IsOptional()
  @IsIn(['ACTIVO', 'INACTIVO'])
  estado_cliente?: string;

  @IsOptional()
  @IsIn(['ACTIVO', 'SUSPENDIDA', 'BAJA_DEFINITIVA'])
  estado_sunat?: string;

  @IsOptional()
  @IsString()
  observaciones?: string;
}

export class GuardarCredencialesDto {
  @IsOptional()
  @IsString()
  sunat_sol_usuario?: string;

  @IsOptional()
  @IsString()
  sunat_sol_password?: string;

  @IsOptional()
  @IsString()
  sunat_api_client_id?: string;

  @IsOptional()
  @IsString()
  sunat_api_client_secret?: string;
}

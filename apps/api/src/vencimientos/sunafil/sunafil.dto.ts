import { IsIn, IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class SincronizarCasillaSunafilDto {
  @IsInt()
  @IsPositive()
  id_empresa!: number;
}

export class GestionarNotificacionSunafilDto {
  @IsIn(['NUEVA', 'EN_REVISION', 'ATENDIDA'])
  estado_gestion!: 'NUEVA' | 'EN_REVISION' | 'ATENDIDA';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}

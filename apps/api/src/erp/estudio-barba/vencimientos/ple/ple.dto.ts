import { IsInt, IsPositive, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class SincronizarPleDto {
  @IsInt()
  @IsPositive()
  id_empresa!: number;

  // Rango opcional: por defecto el servicio barre desde 2011 (arranque del PLE) hasta
  // el año en curso. Acotarlo sirve para re-sincronizar un tramo puntual sin pagar los
  // ~15 viajes contra el portal que cuesta el historial completo.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2011)
  @Max(2100)
  anio_desde?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2011)
  @Max(2100)
  anio_hasta?: number;
}

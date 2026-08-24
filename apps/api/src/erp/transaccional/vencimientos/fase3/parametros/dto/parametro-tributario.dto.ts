import { IsInt, IsString, IsNotEmpty, MaxLength, IsNumber, IsOptional, Min } from 'class-validator';

export class UpsertParametroDto {
  @IsInt() @Min(2000)
  anio: number;

  @IsString() @IsNotEmpty() @MaxLength(50)
  codigo: string;

  @IsNumber()
  valor: number;

  @IsOptional() @IsString() @MaxLength(200)
  descripcion?: string;
}

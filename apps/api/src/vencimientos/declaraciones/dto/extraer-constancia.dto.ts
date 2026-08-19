import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class ExtraerConstanciaDto {
  // Ruta relativa devuelta por /vencimientos/constancias/subir, ej: /uploads/constancias/constancia-xxx.pdf
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  ruta!: string;
}

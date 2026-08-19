import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class CambiarPasswordDto {
  @IsString()
  @IsNotEmpty()
  passwordActual!: string;

  @IsString()
  @MinLength(6, { message: 'Mínimo 6 caracteres' })
  @IsNotEmpty()
  passwordNueva!: string;
}

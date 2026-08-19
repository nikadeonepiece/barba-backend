import { IsInt, IsNotEmpty, IsString, IsEmail, MinLength, IsOptional } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';

export class CreateUsuarioDto {
  @IsInt() 
  @IsNotEmpty() 
  id_rol!: number;

  @IsString() 
  @IsNotEmpty() 
  nombres!: string;

  @IsString() 
  @IsNotEmpty() 
  apellidos!: string;

  @IsEmail({}, { message: 'Correo inválido' }) 
  @IsNotEmpty() 
  correo!: string;
  
  @IsString() 
  @MinLength(6, { message: 'Mínimo 6 caracteres' }) 
  @IsNotEmpty() 
  password!: string;
}

export class UpdateUsuarioDto extends PartialType(CreateUsuarioDto) {}
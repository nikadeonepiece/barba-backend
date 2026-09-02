import { IsInt, IsNotEmpty, IsString, IsEmail, MinLength, IsOptional, Min } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';

export class CreateUsuarioDto {
  @IsInt() 
  @IsNotEmpty() 
  id_rol!: number;

  /**
   * Empresa cliente del usuario. Es lo que convierte una cuenta normal en una cuenta
   * del PORTAL CLIENTE: viaja en el JWT y acota cada consulta de `erp/cliente/`.
   *
   * Se omite (o se manda `null`) para el personal del estudio, que no está atado a
   * ninguna empresa. `@IsOptional()` acepta las dos formas.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  id_empresa?: number | null;

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

import { IsString, IsNotEmpty, MaxLength, IsOptional, IsIn } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';

export class CreateGuiaSunatDto {
  // Código del formulario SUNAT, ej: 0621, 0601 — no hay catálogo cerrado, SUNAT
  // saca formularios nuevos y este módulo existe justamente para no depender de
  // que un desarrollador los agregue al código cada vez.
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  codigo!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nombre!: string;

  // Pasos de navegación, uno por línea (el frontend los junta con \n antes de mandar
  // y los separa con \n al mostrar) — evita otra tabla/FormArray para algo que es,
  // en la práctica, una lista de instrucciones en orden.
  @IsString()
  @IsNotEmpty()
  pasos!: string;

  @IsOptional()
  @IsIn(['ACTIVO', 'INACTIVO'])
  estado?: string;
}

export class UpdateGuiaSunatDto extends PartialType(CreateGuiaSunatDto) {}

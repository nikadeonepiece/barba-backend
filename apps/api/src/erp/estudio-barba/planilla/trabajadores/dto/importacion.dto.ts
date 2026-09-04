import { IsInt, Min, IsOptional, IsObject, IsArray, ValidateNested, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class FilaImportacionDto {
  @IsOptional() @IsNumber() fila?: number;

  // Valores crudos de la fila, indexados por número de columna. Se deja como objeto
  // libre a propósito: las columnas dependen del Excel de cada empresa y el mapeo es
  // el que decide qué significa cada una.
  @IsObject() valores!: Record<string, string>;
}

export class ConfirmarImportacionDto {
  @IsInt() @Min(1) id_empresa!: number;

  // Si no viene, se usa el régimen por defecto de la empresa. Importa: define si a
  // esta gente le toca CTS y gratificación completas o la mitad.
  @IsOptional() @IsInt() @Min(1) id_regimen?: number;

  /** { campo_del_sistema: número_de_columna_del_Excel } */
  @IsObject() mapeo!: Record<string, number>;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilaImportacionDto)
  filas!: FilaImportacionDto[];
}

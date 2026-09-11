import { IsString, IsNotEmpty, IsInt, Min, MaxLength } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';

/**
 * Los tres niveles del árbol comparten forma: un FK al padre y un nombre. El nivel de
 * arriba es el que cambia (empresa → categoría → subcategoría), por eso son tres DTO y
 * no uno genérico con `id_padre`: así el `ValidationPipe` rechaza el POST que manda el
 * FK del nivel equivocado en vez de crear una subcategoría colgada de una empresa.
 *
 * `@Min(1)` y no solo `@IsInt()`: `required` acepta el 0 y un `id_empresa = 0` no
 * falla en el INSERT, cae en el FK con un 500 genérico.
 *
 * `MaxLength(150)` es el largo real de la columna. Sin él, MySQL trunca en silencio
 * (o revienta con 500 según el `sql_mode`) en vez de devolver un 400 que explica qué
 * pasó.
 */
export class CreateCategoriaDto {
  @IsInt() @Min(1) id_empresa: number;
  @IsString() @IsNotEmpty() @MaxLength(150) nombre: string;
}
export class UpdateCategoriaDto extends PartialType(CreateCategoriaDto) {}

export class CreateSubcategoriaDto {
  @IsInt() @Min(1) id_centro_costo_categoria: number;
  @IsString() @IsNotEmpty() @MaxLength(150) nombre: string;
}
export class UpdateSubcategoriaDto extends PartialType(CreateSubcategoriaDto) {}

export class CreateConceptoDto {
  @IsInt() @Min(1) id_centro_costo_subcategoria: number;
  @IsString() @IsNotEmpty() @MaxLength(150) nombre: string;
}
export class UpdateConceptoDto extends PartialType(CreateConceptoDto) {}

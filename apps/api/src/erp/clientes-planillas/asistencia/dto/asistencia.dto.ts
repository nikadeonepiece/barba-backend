import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Un día marcado.
 *
 * `id_marca` no lleva un `@IsIn` con los códigos: las marcas son filas de
 * `planilla_tareo_marca` y el estudio puede agregar una sin desplegar. Que exista y
 * esté activa lo verifica el service contra la tabla, que es donde vive la verdad —
 * un `@IsIn` acá quedaría desactualizado en silencio.
 */
export class DiaAsistenciaDto {
  @IsInt() @Min(1) @Max(31) dia!: number;
  @IsInt() @Min(1) id_marca!: number;

  @IsOptional() @IsString() @MaxLength(255) observacion?: string;
}

/**
 * El mes COMPLETO de un trabajador, no un día suelto.
 *
 * Es la misma decisión que tomó `GuardarTareoDto` en la intranet: la grilla se llena y
 * se corrige como un bloque, y mandar el mes entero hace que un día BORRADO en la
 * pantalla desaparezca de verdad. Con un endpoint por día, borrar exigiría un DELETE
 * aparte que es fácil no llamar, y el día quedaría contado con su valor viejo.
 */
export class TrabajadorAsistenciaDto {
  @IsInt() @Min(1) id_trabajador!: number;

  @IsArray()
  @ArrayMaxSize(31)
  @ValidateNested({ each: true })
  @Type(() => DiaAsistenciaDto)
  dias!: DiaAsistenciaDto[];
}

/**
 * Guardado MASIVO: todos los trabajadores que el usuario tocó, de una sola vez.
 *
 * No es una comodidad de la pantalla, es una regla del proyecto: una acción sobre N
 * filas se resuelve en UNA transacción, nunca en N requests. Con una por trabajador,
 * si la séptima falla quedan seis meses guardados y catorce sin guardar, y la pantalla
 * no tiene forma de decir cuáles — el usuario ve un error y no sabe qué reintentar.
 *
 * El tope de 200 no es arbitrario: es una página de grilla con margen de sobra, y
 * evita que un payload armado a mano abra una transacción de miles de filas en un
 * hosting compartido.
 */
export class GuardarAsistenciaDto {
  @IsInt() @Min(2000) @Max(2100) anio!: number;
  @IsInt() @Min(1) @Max(12) mes!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => TrabajadorAsistenciaDto)
  trabajadores!: TrabajadorAsistenciaDto[];
}

/**
 * Rellena de un saque los días del mes con una misma marca.
 *
 * Existe porque el caso normal es "vinieron todos, todos los días": sin esto son 26
 * clicks por persona y quinientos en una empresa de veinte, y una pantalla que cuesta
 * eso no se llena — el dato vuelve a viajar por WhatsApp, que es lo que se quería
 * evitar.
 *
 * `id_trabajador` opcional: sin él aplica a todo el personal con vínculo vigente.
 */
export class LlenarMesDto {
  @IsInt() @Min(2000) @Max(2100) anio!: number;
  @IsInt() @Min(1) @Max(12) mes!: number;
  @IsInt() @Min(1) id_marca!: number;

  @IsOptional() @IsInt() @Min(1) id_trabajador?: number;

  /**
   * Qué hacer con los días que YA tienen marca.
   *   SOLO_VACIOS  → los respeta (default). Es lo que se quiere después de haber
   *                  marcado a mano las faltas: rellenar el resto con "asistió".
   *   REEMPLAZAR   → pisa el mes entero. Sirve para empezar de nuevo.
   */
  @IsOptional() @IsIn(['SOLO_VACIOS', 'REEMPLAZAR']) modo?: string;

  /**
   * Si los domingos entran o no. Por defecto NO: el domingo es descanso semanal y
   * marcarlo como "asistió" infla los días laborados y con eso el básico del mes.
   */
  @IsOptional() @IsIn(['true', 'false']) incluir_domingos?: string;
}

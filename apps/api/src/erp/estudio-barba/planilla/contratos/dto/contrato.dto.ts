import {
  IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min,
} from 'class-validator';

/** ENUM real de `planilla_contrato.tipo`. Fuera de esta lista, MySQL da un 500 genérico. */
export const TIPOS_CONTRATO = ['CONTRATO', 'ADENDA', 'CONVENIO', 'LIQUIDACION', 'OTRO'] as const;

export class CreateContratoDto {
  @IsInt()
  @Min(1)
  id_trabajador!: number;

  @IsIn(TIPOS_CONTRATO as unknown as string[], {
    message: `El tipo debe ser uno de: ${TIPOS_CONTRATO.join(', ')}`,
  })
  tipo!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  numero?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  descripcion?: string;

  @IsDateString({}, { message: 'La fecha de inicio debe tener formato AAAA-MM-DD' })
  fecha_inicio!: string;

  /** NULL = plazo indeterminado. No se deriva de `fecha_cese`: son hechos distintos. */
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de fin debe tener formato AAAA-MM-DD' })
  fecha_fin?: string | null;

  /**
   * Ruta relativa que devolvió `POST planilla/contratos/subir`.
   *
   * El archivo se sube en un paso APARTE (mismo flujo que las constancias de
   * declaración) y no en el mismo request que estos datos: en un `multipart/form-data`
   * todos los campos llegan como string, así que `@IsInt()`, `@IsBoolean()` y
   * `@IsDateString()` dejarían de validar de verdad y habría que coercionar a mano
   * campo por campo.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  archivo_ruta!: string;

  /** Nombre con el que el usuario lo subió — es el que se le devuelve al descargar. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  archivo_nombre!: string;

  @IsOptional()
  @IsBoolean()
  visible_cliente?: boolean;

  @IsOptional()
  @IsString()
  observaciones?: string;
}

/**
 * DTO propio, escrito a mano, y NO `PartialType(CreateContratoDto)`.
 *
 * Al editar no se cambia ni el trabajador ni el archivo: mover un contrato de una
 * persona a otra deja el PDF apuntando a quien no es, y reemplazar el archivo desde
 * este mismo formulario dejaría el anterior huérfano en disco. Para cualquiera de las
 * dos cosas se sube un contrato nuevo y se da de baja el viejo — que además conserva
 * la historia, que es justamente lo que un legajo tiene que hacer.
 *
 * Con `PartialType` esos campos entrarían igual (el ValidationPipe los aceptaría) y
 * habría que acordarse de ignorarlos en el service. Dejándolos fuera del DTO, mandarlos
 * devuelve 400 y el contrato queda explícito.
 */
export class UpdateContratoDto {
  @IsOptional()
  @IsIn(TIPOS_CONTRATO as unknown as string[], {
    message: `El tipo debe ser uno de: ${TIPOS_CONTRATO.join(', ')}`,
  })
  tipo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  numero?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  descripcion?: string;

  @IsOptional()
  @IsDateString({}, { message: 'La fecha de inicio debe tener formato AAAA-MM-DD' })
  fecha_inicio?: string;

  @IsOptional()
  @IsDateString({}, { message: 'La fecha de fin debe tener formato AAAA-MM-DD' })
  fecha_fin?: string | null;

  @IsOptional()
  @IsBoolean()
  visible_cliente?: boolean;

  @IsOptional()
  @IsString()
  observaciones?: string;
}

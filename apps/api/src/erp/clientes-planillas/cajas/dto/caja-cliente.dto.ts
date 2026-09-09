import { IsString, IsNotEmpty, IsOptional, IsInt, IsNumber, IsIn, Min, MaxLength, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export const MEDIOS_PAGO_CLIENTE = ['EFECTIVO', 'TRANSFERENCIA', 'DEPOSITO', 'YAPE_PLIN', 'TARJETA', 'OTRO'] as const;
export const TIPOS_COMPROBANTE_CLIENTE = ['FACTURA', 'BOLETA', 'RECIBO', 'TICKET', 'VOUCHER', 'NINGUNO'] as const;
export const TIPOS_MOVIMIENTO_CLIENTE = ['INGRESO', 'EGRESO'] as const;

/**
 * DTOs de la caja chica del PORTAL CLIENTE.
 *
 * Son un espejo de los de `tesoreria/cajas` con UNA diferencia, siempre la misma: acá
 * NO viaja `id_empresa`. La caja es siempre la de la empresa del token, y el service la
 * resuelve con `resolverEmpresaDelUsuario`. Si el `id_empresa` viniera en el body,
 * cambiar un número abriría —o vaciaría— la caja de otro cliente.
 *
 * No se reusan los DTO de la intranet justamente por eso: `CreateCajaDto` tiene
 * `id_empresa` obligatorio, y el `ValidationPipe` global corre con
 * `forbidNonWhitelisted`, así que el contrato es el DTO. Tener uno propio es lo que
 * hace que mandar `id_empresa` desde el portal devuelva 400 en vez de funcionar.
 */

/**
 * Apertura de una caja chica.
 *
 * `monto_inicial` admite 0: hay cajas que se abren sin fondo y se cargan con la primera
 * reposición. Lo que no admite es negativo — una caja no nace debiendo.
 */
export class CreateCajaClienteDto {
  @IsString() @IsNotEmpty({ message: 'Ponle un nombre a la caja para poder distinguirla' }) @MaxLength(120)
  nombre!: string;

  @IsOptional() @IsString() @MaxLength(150)
  responsable?: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Type(() => Number)
  monto_inicial!: number;

  @IsDateString()
  fecha_apertura!: string;

  @IsOptional() @IsString() @MaxLength(500)
  observaciones?: string;
}

/**
 * Reemplazo completo de la cabecera de una caja abierta.
 *
 * `monto_inicial` se puede corregir (se tipeó mal el fondo entregado): el service
 * ajusta el movimiento de apertura y rearma la cadena de saldos, y rechaza el cambio si
 * deja la caja en negativo en algún punto de su historia.
 */
export class UpdateCajaClienteDto {
  @IsString() @IsNotEmpty({ message: 'Ponle un nombre a la caja para poder distinguirla' }) @MaxLength(120)
  nombre!: string;

  @IsOptional() @IsString() @MaxLength(150)
  responsable?: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Type(() => Number)
  monto_inicial!: number;

  @IsDateString()
  fecha_apertura!: string;

  @IsOptional() @IsString() @MaxLength(500)
  observaciones?: string;
}

/**
 * Un movimiento del libro: un gasto (EGRESO) o una reposición de fondo (INGRESO).
 *
 * `id_caja` sí viaja, pero el service verifica que esa caja sea de SU empresa antes de
 * tocar nada — el scope sale del token, no de acá.
 */
export class CreateMovimientoCajaClienteDto {
  @IsInt() @Min(1) @Type(() => Number)
  id_caja!: number;

  @IsIn(TIPOS_MOVIMIENTO_CLIENTE as unknown as string[])
  tipo!: string;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number)
  id_caja_concepto?: number;

  // Un movimiento de 0 no mueve plata ni deja rastro útil; el mínimo real es el céntimo.
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Type(() => Number)
  monto!: number;

  @IsDateString()
  fecha!: string;

  @IsOptional() @IsIn(MEDIOS_PAGO_CLIENTE as unknown as string[])
  medio_pago?: string;

  // Obligatoria, al revés que en la intranet: la caja la rinde una persona y la lee
  // otra (el dueño, el contador al cierre). "S/ 45.00" sin una línea de contexto no se
  // puede arquear seis meses después.
  @IsString() @IsNotEmpty({ message: 'Contá en qué se gastó: sin detalle el movimiento no se puede rendir' }) @MaxLength(500)
  descripcion!: string;

  @IsOptional() @IsIn(TIPOS_COMPROBANTE_CLIENTE as unknown as string[])
  tipo_comprobante?: string;

  @IsOptional() @IsString() @MaxLength(50)
  nro_comprobante?: string;

  // Las devuelve `POST cliente/cajas/comprobante` (paso 1 de la carga). Se mandan tal
  // cual: el service no confía en ellas para tocar el disco, solo las guarda.
  @IsOptional() @IsString() @MaxLength(500)
  ruta_comprobante?: string;

  @IsOptional() @IsString() @MaxLength(255)
  nombre_comprobante?: string;
}

/**
 * Corrección de un movimiento ya registrado.
 *
 * `id_caja` y `tipo` quedan fuera: mover un movimiento a otra caja o convertir un gasto
 * en ingreso descuadra los dos saldos involucrados. Para eso se anula y se registra de
 * nuevo, que además deja el rastro de por qué.
 */
export class UpdateMovimientoCajaClienteDto {
  @IsOptional() @IsInt() @Min(1) @Type(() => Number)
  id_caja_concepto?: number;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Type(() => Number)
  monto!: number;

  @IsDateString()
  fecha!: string;

  @IsOptional() @IsIn(MEDIOS_PAGO_CLIENTE as unknown as string[])
  medio_pago?: string;

  @IsString() @IsNotEmpty({ message: 'Contá en qué se gastó: sin detalle el movimiento no se puede rendir' }) @MaxLength(500)
  descripcion!: string;

  @IsOptional() @IsIn(TIPOS_COMPROBANTE_CLIENTE as unknown as string[])
  tipo_comprobante?: string;

  @IsOptional() @IsString() @MaxLength(50)
  nro_comprobante?: string;

  @IsOptional() @IsString() @MaxLength(500)
  ruta_comprobante?: string;

  @IsOptional() @IsString() @MaxLength(255)
  nombre_comprobante?: string;
}

/**
 * El motivo es OBLIGATORIO: una anulación sin explicación deja el arqueo con un agujero
 * que nadie puede justificar seis meses después.
 */
export class AnularMovimientoCajaClienteDto {
  @IsString() @IsNotEmpty({ message: 'Decí por qué se anula: el arqueo tiene que poder explicarlo' }) @MaxLength(255)
  motivo!: string;
}

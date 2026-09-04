import { IsString, IsNotEmpty, IsOptional, IsInt, IsNumber, IsIn, Min, MaxLength, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export const MEDIOS_PAGO_CLIENTE = ['EFECTIVO', 'TRANSFERENCIA', 'DEPOSITO', 'YAPE_PLIN', 'TARJETA', 'OTRO'] as const;
export const TIPOS_COMPROBANTE_CLIENTE = ['FACTURA', 'BOLETA', 'RECIBO', 'TICKET', 'VOUCHER', 'NINGUNO'] as const;

/**
 * Gasto cargado por la EMPRESA desde el portal.
 *
 * Diferencias deliberadas contra `CreateMovimientoCajaDto` de la intranet, y por qué no
 * se reusa aquel DTO:
 *
 *   · No hay `tipo`. El cliente solo registra EGRESOS. Un INGRESO es reponer el fondo,
 *     y esa plata la entrega el estudio o el dueño: si el cliente pudiera cargarla, se
 *     auto-aumentaría el saldo disponible y el control de la revisión no serviría de nada.
 *   · No hay `revision`. La pone el service en POR_REVISAR, siempre. Si viniera del
 *     body, bastaría mandar "APROBADO" para saltarse el control entero.
 *   · `id_caja` sí viaja, pero el service verifica que esa caja sea de SU empresa antes
 *     de tocar nada (el scope sale del token, no de acá).
 */
export class CreateGastoCajaClienteDto {
  @IsInt() @Min(1) @Type(() => Number)
  id_caja!: number;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number)
  id_caja_concepto?: number;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Type(() => Number)
  monto!: number;

  @IsDateString()
  fecha!: string;

  @IsOptional() @IsIn(MEDIOS_PAGO_CLIENTE as unknown as string[])
  medio_pago?: string;

  // Obligatoria, al revés que en la intranet: el estudio va a tener que revisar este
  // gasto sin haber estado ahí, y "S/ 45.00" sin una línea de contexto no se puede
  // aprobar ni rechazar con criterio.
  @IsString() @IsNotEmpty({ message: 'Contá en qué se gastó: el estudio lo revisa sin haber estado ahí' }) @MaxLength(500)
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

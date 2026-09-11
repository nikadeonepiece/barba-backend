import {
  IsArray, IsDateString, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString,
  ArrayMinSize, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PartialType } from '@nestjs/mapped-types';

export const TIPOS_COMPROBANTE = [
  'FACTURA', 'BOLETA', 'RECIBO', 'TICKET', 'PROFORMA', 'NOTA_PEDIDO', 'RECIBO_INTERNO', 'OTRO', 'NINGUNO',
] as const;

export const PRIORIDADES = ['BAJO', 'MEDIO', 'ALTO', 'URGENTE'] as const;

/**
 * Una línea del requerimiento.
 *
 * `subtotal` llega del frontend pero NO se confía: el service recalcula la línea
 * entera con `resolverLinea()` y guarda lo que le dé. Viaja igual porque en modo
 * TOTAL es el dato que el usuario digitó — es la ENTRADA, no el resultado.
 */
export class CreateDetalleRequerimientoDto {
  // Presente solo al editar: identifica la línea que ya existe para actualizarla en
  // vez de borrar y recrear (que perdería el id y con él la trazabilidad).
  @IsOptional() @IsInt() @Min(1) id_detalle?: number;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_centro_costo_concepto?: number;

  @IsNotEmpty({ message: 'El detalle del ítem es obligatorio' })
  @IsString() @MaxLength(500) detalle: string;

  @IsNumber() @Min(0.01, { message: 'La cantidad debe ser mayor que cero' }) @Type(() => Number) cantidad: number;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) precio_unitario?: number;

  // Cuál de los dos números escribió la persona; el otro lo despeja el service.
  @IsOptional() @IsIn(['UNITARIO', 'TOTAL']) modo_ingreso?: 'UNITARIO' | 'TOTAL';

  @IsOptional() @IsIn([0, 1]) @Type(() => Number) con_igv?: number;
  @IsOptional() @IsIn([0, 1]) @Type(() => Number) pago_dolares?: number;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) subtotal?: number;
}

export class CreateRequerimientoDto {
  @IsInt() @Min(1) @Type(() => Number) id_empresa: number;

  @IsDateString({}, { message: 'La fecha de registro no tiene un formato válido' }) fecha_registro: string;
  @IsOptional() @IsDateString() fecha_vencimiento?: string;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_tercero_proveedor?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_trabajador_solicitante?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_trabajador_encargado?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_medio_pago?: number;

  @IsOptional() @IsIn(TIPOS_COMPROBANTE as unknown as string[]) tipo_comprobante?: string;
  @IsOptional() @IsString() @MaxLength(100) nro_comprobante?: string;
  // Las llena el endpoint de subida, no el formulario: el archivo viaja aparte.
  @IsOptional() @IsString() @MaxLength(500) ruta_comprobante?: string;
  @IsOptional() @IsString() @MaxLength(255) nombre_comprobante?: string;

  @IsOptional() @IsIn(PRIORIDADES as unknown as string[]) prioridad?: string;
  @IsOptional() @IsString() @MaxLength(1000, { message: 'La observación no puede superar los 1000 caracteres' }) observacion?: string;

  // `@Type()` es obligatorio con `@ValidateNested`: sin él class-validator recibe
  // objetos planos y no valida NADA de adentro.
  @IsArray()
  @ArrayMinSize(1, { message: 'El requerimiento necesita al menos un ítem' })
  @ValidateNested({ each: true })
  @Type(() => CreateDetalleRequerimientoDto)
  detalles: CreateDetalleRequerimientoDto[];
}

export class UpdateRequerimientoDto extends PartialType(CreateRequerimientoDto) {}

/**
 * Ajuste de una línea desde la pantalla de APROBACIÓN.
 *
 * DTO propio y no `UpdateRequerimientoDto`: finanzas solo puede tocar cantidad, precio
 * y moneda de las líneas que ya existen — no el proveedor, ni el solicitante, ni
 * agregar ítems que nadie pidió. Las líneas que no vengan en el array se dan de baja,
 * que es cómo se quita un ítem que finanzas decide no pagar.
 */
export class AjusteDetalleDto {
  @IsInt() @Min(1) @Type(() => Number) id_detalle: number;
  @IsNumber() @Min(0.01) @Type(() => Number) cantidad: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) precio_unitario?: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) subtotal?: number;
  @IsOptional() @IsIn(['UNITARIO', 'TOTAL']) modo_ingreso?: 'UNITARIO' | 'TOTAL';
  @IsOptional() @IsIn([0, 1]) @Type(() => Number) con_igv?: number;
  @IsOptional() @IsIn([0, 1]) @Type(() => Number) pago_dolares?: number;
}

export class AprobarRequerimientoDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AjusteDetalleDto)
  detalles_ajustados?: AjusteDetalleDto[];

  // Finanzas puede completar el proveedor al aprobar: es lo que falta cuando el
  // requerimiento se registró mientras todavía se cotizaba.
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_tercero_proveedor?: number;
  @IsOptional() @IsDateString() fecha_vencimiento?: string;
  @IsOptional() @IsIn(TIPOS_COMPROBANTE as unknown as string[]) tipo_comprobante?: string;
  @IsOptional() @IsString() @MaxLength(100) nro_comprobante?: string;
}

export class RechazarRequerimientoDto {
  @IsNotEmpty({ message: 'El motivo del rechazo es obligatorio' })
  @IsString() @MaxLength(500) motivo_rechazo: string;
}

/** Query de listado — se valida para que un `limit=999999` no baje la base entera. */
export class ListarRequerimientosQueryDto {
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) @Type(() => Number) limit?: number;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_empresa?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) id_tercero_proveedor?: number;
  @IsOptional() @IsIn(['PENDIENTE', 'APROBADO', 'RECHAZADO']) estado_aprobacion?: string;
  @IsOptional() @IsIn(PRIORIDADES as unknown as string[]) prioridad?: string;
  @IsOptional() @IsDateString() fecha_desde?: string;
  @IsOptional() @IsDateString() fecha_hasta?: string;
  @IsOptional() @IsString() sortCol?: string;
  @IsOptional() @IsIn(['ASC', 'DESC']) sortDir?: 'ASC' | 'DESC';
}

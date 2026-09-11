/**
 * Cálculo de una línea de requerimiento. Vive en un archivo aparte porque lo usan DOS
 * services: el que registra (`requerimientos.service.ts`) y el que aprueba
 * (`aprobacion-requerimientos.service.ts`, que puede ajustar cantidades y precios).
 *
 * Dos implementaciones de "cuánto cuesta esta línea" es cómo aparecen dos totales
 * distintos para el mismo requerimiento — el que ve quien lo pidió y el que termina en
 * la orden de pago.
 */

/** IGV peruano vigente. Si cambia por ley, se cambia acá y en ningún otro lado. */
export const IGV_RATE = 0.18;

export interface LineaEntrada {
  cantidad?: number;
  precio_unitario?: number;
  subtotal?: number;
  con_igv?: number | boolean;
  modo_ingreso?: string;
}

export interface LineaResuelta {
  precio_unitario: number;
  subtotal: number;
  modo_ingreso: 'UNITARIO' | 'TOTAL';
}

/**
 * Una línea se puede digitar de dos formas y el backend siempre recalcula la otra
 * mitad:
 *
 *   UNITARIO → llega el precio unitario; `subtotal = cantidad × unitario (× 1.18 si con_igv)`
 *   TOTAL    → llega el total que cobró el proveedor (con IGV adentro si con_igv = 1)
 *              y se despeja el unitario.
 *
 * El unitario derivado se guarda con SEIS decimales para que `cantidad × unitario`
 * devuelva exactamente el total digitado. Con dos decimales, una línea de 3 unidades a
 * un total de 100 muestra 99.99 y el usuario reporta que "el sistema le cambió el
 * monto de la factura".
 */
export function resolverLinea(det: LineaEntrada): LineaResuelta {
  const cantidad = Number(det.cantidad ?? 1) || 0;
  const factor = det.con_igv ? 1 + IGV_RATE : 1;

  if (det.modo_ingreso === 'TOTAL') {
    const subtotal = Math.round((Number(det.subtotal) || 0) * 100) / 100;
    const pu = cantidad > 0 ? subtotal / factor / cantidad : 0;
    return { precio_unitario: Math.round(pu * 1e6) / 1e6, subtotal, modo_ingreso: 'TOTAL' };
  }

  const precio_unitario = Number(det.precio_unitario ?? 0) || 0;
  const subtotal = Math.round(cantidad * precio_unitario * factor * 100) / 100;
  return { precio_unitario, subtotal, modo_ingreso: 'UNITARIO' };
}

/**
 * Totales separados por moneda. Nunca se suman entre sí: un requerimiento puede
 * mezclar un repuesto importado en dólares con mano de obra en soles, y sumarlos daría
 * un número que no existe. Convertirlos exigiría fijar un tipo de cambio que a esta
 * altura del circuito todavía no se conoce.
 */
export function totalesPorMoneda(
  lineas: { pago_dolares?: number | boolean; subtotal: number }[],
): { total: number; total_dolares: number } {
  return lineas.reduce(
    (acc, linea) => {
      if (Number(linea.pago_dolares) === 1) acc.total_dolares = Math.round((acc.total_dolares + linea.subtotal) * 100) / 100;
      else acc.total = Math.round((acc.total + linea.subtotal) * 100) / 100;
      return acc;
    },
    { total: 0, total_dolares: 0 },
  );
}

/** `DECIMAL` llega como string del driver de MySQL: sin esto, `a + b` concatena. */
export function num(valor: any): number {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

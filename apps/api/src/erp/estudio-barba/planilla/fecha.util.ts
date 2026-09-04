/**
 * Conversión de fechas para el módulo de planilla.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO — el bug que evita:
 * el driver de MySQL devuelve las columnas `DATE` como objetos `Date` de JS, no como
 * strings. Y `String(new Date('2026-01-01'))` NO da '2026-01-01': da
 * 'Wed Jan 01 2026 00:00:00 GMT-0500 (hora estándar de Perú)'. Un `.slice(0, 10)`
 * sobre eso devuelve 'Wed Jan 0', que al pasarse a `new Date(...)` da Invalid Date.
 *
 * Lo peor es cómo falla: `new Date('Wed Jan 0T00:00:00')` no lanza excepción, produce
 * un Invalid Date, y toda comparación con él da `false`. Así que el cálculo no
 * revienta — simplemente toma la rama equivocada y devuelve un número plausible pero
 * incorrecto. En una planilla eso significa pagar mal sin que nadie se entere.
 *
 * Tampoco sirve `toISOString().slice(0, 10)`: convierte a UTC primero, así que en
 * Perú (UTC-5) una fecha local a medianoche retrocede al día anterior.
 *
 * La única forma correcta es leer los componentes locales de la fecha.
 */

/** Convierte a 'YYYY-MM-DD' un valor que puede venir como Date, string o null. */
export function aFechaISO(valor: any): string | null {
  if (valor === null || valor === undefined || valor === '') return null;

  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    const anio = valor.getFullYear();
    const mes = String(valor.getMonth() + 1).padStart(2, '0');
    const dia = String(valor.getDate()).padStart(2, '0');
    return `${anio}-${mes}-${dia}`;
  }

  const texto = String(valor);
  // Ya viene como 'YYYY-MM-DD' o como ISO completo: basta con la parte de fecha.
  if (/^\d{4}-\d{2}-\d{2}/.test(texto)) return texto.slice(0, 10);

  const parseada = new Date(texto);
  return Number.isNaN(parseada.getTime()) ? null : aFechaISO(parseada);
}

/**
 * Convierte a un `Date` a medianoche LOCAL, para comparar fechas sin que la hora ni
 * la zona horaria muevan el día.
 */
export function aFechaLocal(valor: any): Date | null {
  const iso = aFechaISO(valor);
  if (!iso) return null;
  const [anio, mes, dia] = iso.split('-').map(Number);
  return new Date(anio, mes - 1, dia);
}

/** Días completos entre dos fechas, ambas incluidas. Devuelve 0 si el rango es inválido. */
export function diasEntre(desde: Date, hasta: Date): number {
  if (hasta < desde) return 0;
  return Math.floor((hasta.getTime() - desde.getTime()) / 86400000) + 1;
}

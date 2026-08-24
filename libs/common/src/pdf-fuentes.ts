// Registro ÚNICO de fuentes y políticas de acceso de pdfmake para todo el backend.
//
// Por qué existe este archivo: en pdfmake 0.3 el módulo exporta un SINGLETON. `setFonts()`
// REEMPLAZA el set completo y `setLocalAccessPolicy()` pisa la política anterior. Con dos
// servicios de PDF (el de docDefinition con Helvetica y el de HTML con Roboto) registrando
// por su cuenta, el que cargara último dejaba al otro sin fuentes — un fallo silencioso que
// solo aparece al generar el PDF, nunca al compilar. Por eso ambos importan de acá.
//
// Roboto va embebida como base64 (fonts-data.ts) y se registra en el sistema de archivos
// VIRTUAL de pdfmake. Es obligatorio: desde 0.3 el `URLResolver` exige que los descriptores
// de fuente sean rutas string y revienta si se le pasa un Buffer directo. El virtual-fs
// permite seguir sin depender de que el build copie .ttf al dist.
import pdfMake = require('pdfmake');
import {
  ROBOTO_REGULAR_B64,
  ROBOTO_BOLD_B64,
  ROBOTO_ITALIC_B64,
  ROBOTO_BOLDITALIC_B64,
} from './fonts-data';

const vfs = require('pdfmake/js/virtual-fs').default;

/** Nombres de archivo virtuales de Roboto (no existen en disco, viven en memoria). */
export const ARCHIVOS_ROBOTO = {
  normal: 'Roboto-Regular.ttf',
  bold: 'Roboto-Medium.ttf',
  italics: 'Roboto-Italic.ttf',
  bolditalics: 'Roboto-MediumItalic.ttf',
} as const;

/**
 * Buffers crudos de Roboto. pdfmake ya no los acepta directo, pero fontkit sí — se usan para
 * medir el ancho real del texto al calcular anchos de columna (ver PdfHtmlService).
 */
export const BUFFERS_ROBOTO = {
  normal: Buffer.from(ROBOTO_REGULAR_B64, 'base64'),
  bold: Buffer.from(ROBOTO_BOLD_B64, 'base64'),
  italics: Buffer.from(ROBOTO_ITALIC_B64, 'base64'),
  bolditalics: Buffer.from(ROBOTO_BOLDITALIC_B64, 'base64'),
};

// Las 14 fuentes base que todo lector de PDF trae incorporadas. No se embeben: son nombres
// que pdfkit reconoce. Las usan los reportes construidos con docDefinition (PdfService).
const FUENTES_ESTANDAR = require('pdfmake/standard-fonts/Helvetica');

/**
 * Familia por defecto de los reportes construidos con docDefinition (PdfService).
 * Hay que pasarla EXPLÍCITAMENTE en `defaultStyle`: como acá también se registra Roboto,
 * pdfmake la elige a ella por omisión y esos reportes cambiarían de tipografía sin aviso.
 */
export const FUENTE_ESTANDAR = 'Helvetica';

// Roboto al virtual-fs, una sola vez al cargar el módulo.
vfs.writeFileSync(ARCHIVOS_ROBOTO.normal, BUFFERS_ROBOTO.normal);
vfs.writeFileSync(ARCHIVOS_ROBOTO.bold, BUFFERS_ROBOTO.bold);
vfs.writeFileSync(ARCHIVOS_ROBOTO.italics, BUFFERS_ROBOTO.italics);
vfs.writeFileSync(ARCHIVOS_ROBOTO.bolditalics, BUFFERS_ROBOTO.bolditalics);

// setFonts (reemplaza) para las estándar + addFonts (fusiona) para Roboto: así conviven las
// dos familias y ningún servicio deja al otro sin fuente.
pdfMake.setFonts(FUENTES_ESTANDAR);
pdfMake.addFonts({ Roboto: { ...ARCHIVOS_ROBOTO } });

// Todo nombre/ruta de fuente pasa por el validador de "acceso a archivo local", incluidos los
// nombres de las estándar ("Helvetica-Bold") y nuestros .ttf virtuales. Sin autorizarlos acá,
// pdfmake los rechaza y ni siquiera puede escribir en negrita.
const RUTAS_PERMITIDAS = new Set<string>([
  ...Object.values(FUENTES_ESTANDAR).flatMap((variantes: any) => Object.values(variantes) as string[]),
  ...Object.values(ARCHIVOS_ROBOTO),
]);

// Ningún reporte referencia imágenes por URL ni por ruta de disco — solo texto, tablas y las
// fuentes de arriba — así que se deniega cualquier otro acceso explícitamente.
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy((ruta: string) => RUTAS_PERMITIDAS.has(ruta));

export { pdfMake };

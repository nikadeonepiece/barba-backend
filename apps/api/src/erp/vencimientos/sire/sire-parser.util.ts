import * as unzipper from 'unzipper';

// Mapeo de columnas verificado contra archivos reales descargados de SUNAT
// (ver YUNTA-ERP: RCE 20605191143-...-preliminar.txt / RVIE LE20605191143...EXP2.txt,
// 2026-08-09). SUNAT no expone estas posiciones en la respuesta JSON del ticket —
// solo en el propio TXT, con un layout fijo por tipo de libro que no coincide entre
// RCE y RVIE (por eso van mapeos separados, no genéricos). Portado tal cual desde el
// proyecto YUNTA-ERP, donde ya está probado contra SUNAT real.
export interface FilaSireParseada {
  tipo_doc: string;
  tipo_doc_label: string;
  serie: string;
  numero: string;
  fecha_emision: string;
  ruc_tercero: string;
  razon_social_tercero: string;
  moneda: string;
  base_imponible: number;
  igv: number;
  total: number;
  glosa: string;
}

const TIPO_DOC_LABEL: Record<string, string> = {
  '01': 'Factura',
  '03': 'Boleta',
  '07': 'Nota de Crédito',
  '08': 'Nota de Débito',
  '09': 'Guía de Remisión',
  '12': 'Ticket',
  '91': 'Comprobante SEAE',
};

function etiquetaTipoDoc(codigo: string): string {
  return TIPO_DOC_LABEL[codigo] || codigo || '---';
}

function armarGlosa(tipoLibro: string, tipoDocLabel: string, serie: string, numero: string, razonSocial: string, ruc: string): string {
  const comprobante = `${tipoDocLabel} ${serie}-${numero}`;
  const tercero = ruc && ruc !== '0' ? `${razonSocial} (RUC ${ruc})` : razonSocial;
  const accion = tipoLibro === 'RCE' ? 'Compra según' : 'Venta según';
  return `${accion} ${comprobante} — ${tercero}`;
}

function parseNumero(valor: string): number {
  const n = parseFloat((valor || '0').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

// El ZIP de SUNAT trae un único .txt (nombre variable según el proceso que lo
// generó) — se toma el primero que aparezca con esa extensión.
async function extraerTxtDelZip(bufferZip: Buffer): Promise<string> {
  const directorio = await unzipper.Open.buffer(bufferZip);
  const entrada = directorio.files.find((f: any) => f.path.toLowerCase().endsWith('.txt'));
  if (!entrada) throw new Error('El ZIP de SUNAT no contiene un archivo .txt');
  const contenido: Buffer = await entrada.buffer();
  // RVIE viene con BOM UTF-8, RCE no — se limpia si está presente.
  let texto = contenido.toString('utf-8');
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1);
  return texto;
}

export async function parsearArchivoSire(bufferZip: Buffer, tipoLibro: string): Promise<FilaSireParseada[]> {
  const texto = await extraerTxtDelZip(bufferZip);
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const filas = lineas.slice(1); // la primera línea es la cabecera de columnas de SUNAT

  return filas.map((linea) => {
    const c = linea.split('|');
    const base = tipoLibro === 'RCE'
      ? {
          tipo_doc: c[6] || '', serie: c[7] || '', numero: c[9] || '', fecha_emision: c[4] || '',
          ruc_tercero: c[12] || '', razon_social_tercero: c[13] || '', moneda: c[25] || '',
          base_imponible: parseNumero(c[14]), igv: parseNumero(c[15]), total: parseNumero(c[24]),
        }
      : {
          tipo_doc: c[6] || '', serie: c[7] || '', numero: c[8] || '', fecha_emision: c[4] || '',
          ruc_tercero: c[11] || '', razon_social_tercero: c[12] || '', moneda: c[26] || '',
          base_imponible: parseNumero(c[14]), igv: parseNumero(c[16]), total: parseNumero(c[25]),
        };
    const tipo_doc_label = etiquetaTipoDoc(base.tipo_doc);
    const glosa = armarGlosa(tipoLibro, tipo_doc_label, base.serie, base.numero, base.razon_social_tercero, base.ruc_tercero);
    return { ...base, tipo_doc_label, glosa };
  });
}

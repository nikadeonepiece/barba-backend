// LA VÍA BUENA — bajar el XML de una venta y sacarle el detalle de ítems.
//
// Descubierto el 08/09/2026 recorriendo el menú de SOL por código:
//   opción 11.5.3.1.2 "Consulta de Facturas y Notas Electrónicas"
//   → https://ww1.sunat.gob.pe/ol-ti-itconscpemype/consultar.do
//
// Ese servlet expone justo lo que hace falta (visto en su propio HTML):
//   action=realizarConsulta  + fec_desde/fec_hasta/tipoConsulta=10 → lista de CPE
//   action=descargarFactura  + ruc/tipo/serie/numero               → el XML
//   action=descargarPDF / descargarComprobanteEnPdf                → el PDF
//   además tiene "Solicitar descarga Masiva" para lotes
//
// POR QUÉ ESTE MÓDULO Y NO OTRO: RG TRANSPORTES emite con serie E001, y la "E" es la
// firma del SEE-SOL (emisión desde el portal). Sus XML viven acá, no en el facturador
// de un tercero. Ojo: para un cliente que emita con serie F### (SEE propio u OSE) este
// módulo NO va a tener sus comprobantes — ahí hay que ir contra su facturador.
//
// El módulo 11.38.1.1.1 (que sería el general, con compras incluidas) devuelve
// ERROR 404 de SUNAT: está caído del lado de ellos. Ver la memoria del proyecto.
//
// Uso: node descargar-xml-ventas.js <RUC> [DD/MM/AAAA_desde] [DD/MM/AAAA_hasta]
require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { chromium } = require('playwright');

const SEL = {
  LOGIN_URL: 'https://www.sunat.gob.pe/sol.html',
  LINK_TRAMITES: 'a[href*="tramiteConsulta"]',
  BOTON_POR_RUC: '#btnPorRuc',
  IFRAME_CONTIENE: 'api-seguridad.sunat.gob.pe',
  INPUT_RUC: '#txtRuc',
  INPUT_USUARIO: '#txtUsuario',
  INPUT_CLAVE: '#txtContrasena',
  BOTON_INGRESAR: '#btnAceptar',
};
const CODIGO = '11.5.3.1.2';
const APP = 'ol-ti-itconscpemype';
const CARPETA = path.join(process.cwd(), 'storage-privado', 'debug-cpe');

function descifrar(buffer, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
}

async function credenciales(ruc) {
  const key = process.env.CREDENCIALES_ENCRYPTION_KEY;
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
  });
  const [[e]] = await conn.query(
    `SELECT razon_social, sunat_sol_usuario, sunat_sol_password FROM empresa WHERE ruc = ?`, [ruc]);
  await conn.end();
  if (!e || !e.sunat_sol_usuario) throw new Error(`Empresa ${ruc} sin credenciales SOL`);
  return {
    razonSocial: e.razon_social,
    usuario: descifrar(e.sunat_sol_usuario, key).trim(),
    clave: descifrar(e.sunat_sol_password, key).trim(),
  };
}

// Imprime las líneas de detalle del XML UBL. Esto es LO QUE EL SIRE NO TIENE.
function mostrarItems(xml, etiqueta) {
  const lineas = xml.split(/<cac:InvoiceLine>/).slice(1);
  console.log(`\n  === DETALLE DE ${etiqueta} — ${lineas.length} ítem(s) ===`);
  if (!lineas.length) {
    const alt = xml.split(/<cac:CreditNoteLine>/).slice(1);
    if (alt.length) console.log(`  (es nota de crédito: ${alt.length} línea(s) en cac:CreditNoteLine)`);
    else console.log('  (sin cac:InvoiceLine — revisar el tipo de documento)');
    return;
  }
  lineas.forEach((l, i) => {
    const g = (re) => (l.match(re) || [])[1]?.trim();
    const desc = g(/<cbc:Description[^>]*>([\s\S]*?)<\/cbc:Description>/);
    const cant = g(/<cbc:InvoicedQuantity[^>]*>([\s\S]*?)<\/cbc:InvoicedQuantity>/);
    const pu = g(/<cbc:PriceAmount[^>]*>([\s\S]*?)<\/cbc:PriceAmount>/);
    const total = g(/<cbc:LineExtensionAmount[^>]*>([\s\S]*?)<\/cbc:LineExtensionAmount>/);
    const cod = g(/<cac:SellersItemIdentification>\s*<cbc:ID[^>]*>([\s\S]*?)<\/cbc:ID>/);
    console.log(`   ${i + 1}. ${desc || '(sin descripción)'}`);
    console.log(`      código: ${cod || '-'} | cantidad: ${cant || '-'} | P.U.: ${pu || '-'} | importe: ${total || '-'}`);
  });
}

async function main() {
  const ruc = process.argv[2] || '20539814452';
  const desde = process.argv[3] || '01/02/2026';
  const hasta = process.argv[4] || '28/02/2026';
  const cred = await credenciales(ruc);
  console.log('Empresa:', cred.razonSocial, `(${ruc})`);
  console.log('Rango  :', desde, '→', hasta, '\n');
  fs.mkdirSync(CARPETA, { recursive: true });

  const browser = await chromium.launch({ headless: true, timeout: 30_000 });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      locale: 'es-PE', acceptDownloads: true,
    });
    const page = await context.newPage();
    await page.goto(SEL.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      page.click(SEL.LINK_TRAMITES),
    ]);
    await popup.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    await popup.click(SEL.BOTON_POR_RUC).catch(() => {});
    const fr = popup.frames().find((f) => f.url().includes(SEL.IFRAME_CONTIENE));
    if (!fr) throw new Error('No apareció el iframe de login');
    await fr.fill(SEL.INPUT_RUC, ruc);
    await fr.fill(SEL.INPUT_USUARIO, cred.usuario);
    await fr.fill(SEL.INPUT_CLAVE, cred.clave);
    await Promise.all([
      popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
      popup.click(SEL.BOTON_INGRESAR),
    ]);
    await popup.waitForTimeout(2500);
    console.log('Login OK');

    await popup.evaluate((codigo) => {
      window.ejecuta(`MenuInternet.htm?action=iconExecute&code=${codigo}`, false,
        'consulta', `#nivel1_${codigo.split('.')[0]}`, codigo);
    }, CODIGO);
    await popup.waitForTimeout(12000);

    const app = popup.frames().find((f) => f.url().includes(APP));
    if (!app) throw new Error(`No cargó el módulo ${APP} — ¿SUNAT lo cambió?`);
    console.log('Módulo cargado');

    // Las peticiones se hacen DESDE el frame para heredar cookies y el `hc` de sesión
    // que el servlet exige (viaja en la query de la URL del propio frame).
    const query = app.url().split('?')[1] || '';

    console.log('\n--- Consultando comprobantes ---');
    const html = await app.evaluate(async ({ query, desde, hasta }) => {
      const body = new URLSearchParams({
        action: 'realizarConsulta', buscarPor: 'porPer', estado: '1',
        fec_desde: desde, fec_hasta: hasta, tipoConsulta: '10',
      });
      const r = await fetch(`consultar.do?${query}`, {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      return await r.text();
    }, { query, desde, hasta });
    fs.writeFileSync(path.join(CARPETA, `consulta-${ruc}.html`), html, 'utf8');
    console.log(`  respuesta: ${html.length} bytes (guardada en debug-cpe/consulta-${ruc}.html)`);

    // El servlet NO devuelve una tabla: devuelve un <textarea> con JSON adentro, y el
    // campo `data` es a su vez un STRING con JSON (doble codificación).
    const enTextarea = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
    if (!enTextarea) throw new Error('La respuesta no trae <textarea> — el servlet cambió de formato');
    const sobre = JSON.parse(enTextarea[1]);
    if (sobre.codeError && sobre.codeError !== 0) {
      throw new Error(`SUNAT devolvió codeError=${sobre.codeError}: ${sobre.msgError || 'sin detalle'}`);
    }
    const comprobantes = (typeof sobre.data === 'string' ? JSON.parse(sobre.data) : sobre.data || [])
      .filter((c) => c.ind_puede_descargar === '1')
      .map((c) => ({
        serie: c.nroSerie,
        numero: c.nroFactura,
        tipo: c.codCpe,
        fecha: c.fechaEmisionDesc,
        receptor: c.nroRucReceptorDesc,
        total: c.importeTotalDesc,
      }));
    if (!comprobantes.length) {
      console.log('  No se detectaron comprobantes en la respuesta.');
      console.log('  Revisá debug-cpe/consulta-*.html — puede pedir otro filtro o no haber datos en el rango.');
      return;
    }
    console.log(`  ${comprobantes.length} comprobante(s) descargables:`);
    comprobantes.slice(0, 8).forEach((c) => console.log(`    ${c.serie}-${c.numero}  ${c.fecha}  ${c.total}  ${c.receptor}`));

    // Se baja el XML del primero. La respuesta es un ZIP; se transfiere en base64
    // porque page.evaluate() no puede devolver binario.
    const cp = comprobantes[0];
    console.log(`\n--- Descargando XML de ${cp.serie}-${cp.numero} ---`);
    const b64 = await app.evaluate(async ({ query, ruc, cp }) => {
      const body = new URLSearchParams({
        action: 'descargarFactura', ruc, tipo: cp.tipo || '01', serie: cp.serie, numero: cp.numero,
      });
      const r = await fetch(`consultar.do?${query}`, {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const buf = await r.arrayBuffer();
      let s = '';
      new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
      return { status: r.status, tipo: r.headers.get('content-type') || '', datos: btoa(s) };
    }, { query, ruc, cp });

    const buffer = Buffer.from(b64.datos, 'base64');
    console.log(`  status ${b64.status} | ${b64.tipo} | ${buffer.length} bytes`);
    const destino = path.join(CARPETA, `${cp.serie}-${cp.numero}.zip`);
    fs.writeFileSync(destino, buffer);

    let xml = null;
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
      const dir = await unzipper.Open.buffer(buffer);
      const ent = dir.files.find((f) => f.path.toLowerCase().endsWith('.xml'));
      if (ent) xml = (await ent.buffer()).toString('utf-8');
      console.log(`  ZIP con: ${dir.files.map((f) => f.path).join(', ')}`);
    } else if (/xml/i.test(b64.tipo) || buffer.slice(0, 5).toString() === '<?xml') {
      xml = buffer.toString('utf-8');
    }

    if (!xml) {
      console.log('  No se obtuvo XML. Primeros bytes:', buffer.slice(0, 200).toString('utf-8'));
      return;
    }
    fs.writeFileSync(path.join(CARPETA, `${cp.serie}-${cp.numero}.xml`), xml, 'utf8');
    mostrarItems(xml, `${cp.serie}-${cp.numero}`);
    console.log(`\n  XML guardado en storage-privado/debug-cpe/${cp.serie}-${cp.numero}.xml`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });

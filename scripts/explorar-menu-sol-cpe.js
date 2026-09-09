// ETAPA 1 DE DESCUBRIMIENTO — headless, sin intervención humana.
//
// Objetivo: encontrar por dónde se llega, dentro del menú de SOL, al módulo de
// comprobantes de pago (para después bajar el XML con su detalle de ítems).
//
// MÉTODO: el mismo que ya se usó en este repo para llegar a "Consulta de Declaraciones
// y Pagos" (ver sunat-scraping.client.ts y la carpeta storage-privado/debug-sire):
// entrar headless, volcar el HTML de la página y de TODOS sus frames, y leer el
// volcado para deducir los selectores reales. Nada de adivinar a ciegas.
//
// ⚠️ PUERTA: se entra por "Mis trámites y consultas" (tramiteConsulta), NO por
// "Mis Declaraciones y Pagos". Están documentadas en catalogos/empresas/
// sunat-login.client.ts: la de Declaraciones deja la sesión ENCERRADA en ese módulo
// y desde ahí no se llega a Comprobantes de pago. No se puede saltar de una a otra
// por URL — cada app hace su propio handoff de token.
//
// No hace clics de exploración a propósito: primero se mira qué hay. Cada login
// cuesta, y el WAF de SUNAT corta cuando ve varias sesiones seguidas.
//
// Uso: node explorar-menu-sol-cpe.js <RUC>
require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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

const CARPETA = path.join(process.cwd(), 'storage-privado', 'debug-cpe');
// Lo que buscamos en los textos del menú.
const BUSCADO = /comprobante|cpe|factura|consulta integrada|recibid|emitid/i;

function descifrar(buffer, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
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
  if (!e) throw new Error(`Empresa ${ruc} no encontrada`);
  if (!e.sunat_sol_usuario) throw new Error(`Empresa ${ruc} sin credenciales SOL`);
  return {
    razonSocial: e.razon_social,
    usuario: descifrar(e.sunat_sol_usuario, key).trim(),
    clave: descifrar(e.sunat_sol_password, key).trim(),
  };
}

// Vuelca HTML + PNG de la página y el HTML de cada frame. Copiado del guardarDebug()
// de sunat-scraping.client.ts — va a storage-privado (nunca a uploads/, que se sirve
// público sin login) porque el HTML de una sesión SOL trae datos del contribuyente.
async function volcar(page, ruc, etapa) {
  fs.mkdirSync(CARPETA, { recursive: true });
  const base = `${etapa}-${ruc}`;
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(CARPETA, `${base}.html`), html, 'utf8');
  } catch {}
  await page.screenshot({ path: path.join(CARPETA, `${base}.png`), fullPage: true }).catch(() => {});
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    try {
      const h = await frames[i].content();
      fs.writeFileSync(path.join(CARPETA, `${base}-frame-${i}.html`), h, 'utf8');
    } catch {}
  }
  console.log(`  volcado: ${base}.* (${frames.length} frame(s))`);
}

// Junta todo lo clickeable de una página y sus frames: texto, href y onclick.
// El menú de SOL es un árbol de <a> con javascript:, no links normales.
async function inventariarMenu(page) {
  const items = [];
  for (const frame of page.frames()) {
    let encontrados = [];
    try {
      encontrados = await frame.evaluate(() => {
        const salida = [];
        document.querySelectorAll('a, [onclick], li, span').forEach((el) => {
          const texto = (el.textContent || '').trim().replace(/\s+/g, ' ');
          if (!texto || texto.length > 120) return;
          const href = el.getAttribute('href') || '';
          const onclick = el.getAttribute('onclick') || '';
          const id = el.getAttribute('id') || '';
          if (!href && !onclick && !id) return;
          salida.push({ texto, href, onclick, id, tag: el.tagName });
        });
        return salida;
      });
    } catch {}
    encontrados.forEach((e) => items.push({ ...e, frame: frame.url().slice(0, 80) }));
  }
  return items;
}

async function main() {
  const ruc = process.argv[2];
  if (!ruc) { console.error('Uso: node explorar-menu-sol-cpe.js <RUC>'); process.exit(1); }
  const cred = await credenciales(ruc);
  console.log('Empresa:', cred.razonSocial, `(${ruc})`);

  const browser = await chromium.launch({ headless: true, timeout: 30_000 });
  let etapa = 'inicio';
  let pageActual = null;
  try {
    const context = await browser.newContext({
      // Sin un User-Agent de navegador real SUNAT devuelve una página vacía antes de
      // llegar a cualquier selector (verificado en vivo, ver sunat-scraping.client.ts).
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      locale: 'es-PE',
      acceptDownloads: true,
    });

    // Registro de red: si alguna pantalla ya pega contra un servicio de comprobantes,
    // queremos la URL aunque no lleguemos a descargar nada.
    const urlsVistas = new Set();
    context.on('request', (req) => {
      const u = req.url();
      if (/\.(css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico)(\?|$)/i.test(u)) return;
      if (BUSCADO.test(u)) urlsVistas.add(`${req.method()} ${u}`);
    });

    const page = await context.newPage();
    pageActual = page;
    await page.goto(SEL.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    etapa = 'login-popup';
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      page.click(SEL.LINK_TRAMITES),
    ]);
    await popup.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    pageActual = popup;
    await popup.click(SEL.BOTON_POR_RUC).catch(() => {});

    const frame = popup.frames().find((f) => f.url().includes(SEL.IFRAME_CONTIENE));
    if (!frame) throw new Error('No se encontró el iframe de login OAuth2 — el portal cambió');
    await frame.fill(SEL.INPUT_RUC, ruc);
    await frame.fill(SEL.INPUT_USUARIO, cred.usuario);
    await frame.fill(SEL.INPUT_CLAVE, cred.clave);

    etapa = 'post-login';
    const [respuesta] = await Promise.all([
      popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
      popup.click(SEL.BOTON_INGRESAR),
    ]);
    await popup.waitForTimeout(2500);

    // SUNAT devuelve su propio 500 o el WAF corta con "Request Rejected" — si no se
    // detecta acá, el flujo "termina bien" con un menú vacío y sin explicación.
    const cuerpo = (await popup.textContent('body').catch(() => '')) ?? '';
    const status = respuesta?.status() ?? 0;
    if (status >= 500 || /Request failed|Request Rejected|HTTP ERROR 5\d\d/i.test(cuerpo)) {
      throw new Error(`SUNAT respondió error de servidor (${status || 'oauth2/authen'}). ` +
        'Suele ser saturación o corte del WAF. Esperá unos minutos y reintentá.');
    }

    etapa = 'menu';
    await volcar(popup, ruc, 'menu');

    console.log('\n================ MENÚ DE SOL ================');
    const items = await inventariarMenu(popup);
    console.log(`Elementos inventariados: ${items.length}\n`);

    const relevantes = items.filter((i) => BUSCADO.test(i.texto));
    if (relevantes.length) {
      console.log('>>> COINCIDENCIAS con comprobante/CPE/factura:\n');
      relevantes.forEach((i) => {
        console.log(`  "${i.texto}"`);
        if (i.href && i.href !== '#') console.log(`      href: ${i.href.slice(0, 140)}`);
        if (i.onclick) console.log(`      onclick: ${i.onclick.slice(0, 140)}`);
        if (i.id) console.log(`      id: ${i.id}`);
      });
    } else {
      console.log('Sin coincidencias directas. Menú de primer nivel encontrado:\n');
      const vistos = new Set();
      items.filter((i) => i.texto.length < 60).forEach((i) => {
        if (vistos.has(i.texto)) return;
        vistos.add(i.texto);
        console.log(`  "${i.texto}"${i.id ? `  (id=${i.id})` : ''}`);
      });
    }

    if (urlsVistas.size) {
      console.log('\n>>> URLs de red que ya mencionan comprobantes:');
      urlsVistas.forEach((u) => console.log(`  ${u}`));
    }

    console.log(`\nHTML completo en: storage-privado/debug-cpe/`);
    console.log('Pegame esta salida y con eso defino el siguiente clic.');
  } catch (e) {
    console.error(`\nFALLÓ en etapa "${etapa}": ${e.message}`);
    // El volcado del fallo es lo que permite corregir el selector sin volver a loguearse.
    if (pageActual) await volcar(pageActual, ruc, `error-${etapa}`).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

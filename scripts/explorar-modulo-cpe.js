// ETAPA 2 DE DESCUBRIMIENTO — entrar al módulo de comprobantes y ver qué expone.
//
// Etapa 1 (explorar-menu-sol-cpe.js) volcó el menú completo: 752 opciones, cada una
// con su `data-id` = código de opción. La candidata es:
//
//     11.38.1.1.1  "Nueva Consulta de comprobantes de pago"
//
// CLAVE: el menú de SOL no navega por clics anidados sino llamando a una función JS
// global `ejecuta(url, flag, titulo, padre, codigo)`. Se la puede invocar directo
// desde page.evaluate() — mucho más robusto que abrir 4 niveles de árbol a ciegas, y
// además evita depender de que cada nivel esté visible.
//
// Este script NO intenta descargar nada todavía: entra, vuelca todo y lista los
// controles del formulario. Con eso se decide cómo manejarlo. Un login por etapa —
// el WAF de SUNAT castiga las sesiones seguidas.
//
// Uso: node explorar-modulo-cpe.js <RUC> [CODIGO]
require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CODIGO_POR_DEFECTO = '11.38.1.1.1';

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
  if (!e || !e.sunat_sol_usuario) throw new Error(`Empresa ${ruc} sin credenciales SOL`);
  return {
    razonSocial: e.razon_social,
    usuario: descifrar(e.sunat_sol_usuario, key).trim(),
    clave: descifrar(e.sunat_sol_password, key).trim(),
  };
}

async function volcar(page, ruc, etapa) {
  fs.mkdirSync(CARPETA, { recursive: true });
  const base = `${etapa}-${ruc}`;
  try { fs.writeFileSync(path.join(CARPETA, `${base}.html`), await page.content(), 'utf8'); } catch {}
  await page.screenshot({ path: path.join(CARPETA, `${base}.png`), fullPage: true }).catch(() => {});
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    try { fs.writeFileSync(path.join(CARPETA, `${base}-frame-${i}.html`), await frames[i].content(), 'utf8'); } catch {}
  }
  return frames;
}

// Lista los controles de cada frame: es lo que hace falta para saber cómo manejar el
// formulario (qué filtros tiene, si pide período, si hay botón de descarga).
async function inventariarControles(page) {
  for (const frame of page.frames()) {
    let ctrls = [];
    try {
      ctrls = await frame.evaluate(() => {
        const out = [];
        document.querySelectorAll('select, input, button, a[onclick], [ng-click]').forEach((el) => {
          const texto = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
          out.push({
            tag: el.tagName,
            tipo: el.getAttribute('type') || '',
            id: el.getAttribute('id') || '',
            name: el.getAttribute('name') || '',
            ngClick: el.getAttribute('ng-click') || '',
            onclick: (el.getAttribute('onclick') || '').slice(0, 100),
            texto,
            opciones: el.tagName === 'SELECT'
              ? Array.from(el.options).slice(0, 15).map((o) => `${o.value}=${o.text}`.slice(0, 40))
              : undefined,
          });
        });
        return out;
      });
    } catch {}
    if (!ctrls.length) continue;
    console.log(`\n--- frame: ${frame.url().slice(0, 120)} ---`);
    ctrls.forEach((c) => {
      const ident = c.id || c.name || c.texto || '(sin id)';
      console.log(`  ${c.tag}${c.tipo ? `[${c.tipo}]` : ''}  ${ident}`);
      if (c.ngClick) console.log(`      ng-click: ${c.ngClick}`);
      if (c.onclick) console.log(`      onclick: ${c.onclick}`);
      if (c.opciones?.length) console.log(`      opciones: ${c.opciones.join(' | ')}`);
    });
  }
}

async function main() {
  const ruc = process.argv[2];
  const codigo = process.argv[3] || CODIGO_POR_DEFECTO;
  if (!ruc) { console.error('Uso: node explorar-modulo-cpe.js <RUC> [CODIGO]'); process.exit(1); }
  const cred = await credenciales(ruc);
  console.log('Empresa:', cred.razonSocial, `(${ruc})`);
  console.log('Código de opción SOL:', codigo, '\n');

  // HEADLESS=false abre el navegador en pantalla. Sirve para comprobar si un módulo
  // que falla headless también falla para una persona — si el loader de SUNAT da 404
  // en ambos casos, el módulo está caído del lado de ellos y no es cosa nuestra.
  const visible = process.env.HEADLESS === 'false';
  const browser = await chromium.launch({
    headless: !visible,
    timeout: 30_000,
    args: visible ? ['--start-maximized', '--window-position=0,0'] : [],
  });
  let etapa = 'inicio';
  let pageActual = null;
  const red = [];
  const apiCpe = [];
  let tokenPortal = null;
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      locale: 'es-PE', acceptDownloads: true,
    });
    context.on('request', (req) => {
      const u = req.url();
      if (/\.(css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico)(\?|$)/i.test(u)) return;
      red.push(`${req.method()} ${u}`);
      // Las llamadas de la SPA a la API son EL objetivo: son los endpoints reales.
      if (/api-cpe\.sunat\.gob\.pe/.test(u)) {
        apiCpe.push({ metodo: req.method(), url: u, body: req.postData()?.slice(0, 1500) || null });
        console.log(`\n>>> API-CPE  ${req.method()} ${u}`);
        const b = req.postData();
        if (b) console.log(`    body: ${b.slice(0, 600)}`);
      }
      // El token del portal viaja en la URL del loader de la SPA.
      const t = u.match(/consultacpe\/consulta\/loader\/[^?]*\?token=([^&]+)/);
      if (t) tokenPortal = decodeURIComponent(t[1]);
    });

    const page = await context.newPage();
    pageActual = page;
    await page.goto(SEL.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    etapa = 'login';
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      page.click(SEL.LINK_TRAMITES),
    ]);
    await popup.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    pageActual = popup;
    await popup.click(SEL.BOTON_POR_RUC).catch(() => {});
    const frame = popup.frames().find((f) => f.url().includes(SEL.IFRAME_CONTIENE));
    if (!frame) throw new Error('No se encontró el iframe de login OAuth2');
    await frame.fill(SEL.INPUT_RUC, ruc);
    await frame.fill(SEL.INPUT_USUARIO, cred.usuario);
    await frame.fill(SEL.INPUT_CLAVE, cred.clave);
    const [resp] = await Promise.all([
      popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
      popup.click(SEL.BOTON_INGRESAR),
    ]);
    await popup.waitForTimeout(2500);
    const cuerpo = (await popup.textContent('body').catch(() => '')) ?? '';
    if ((resp?.status() ?? 0) >= 500 || /Request failed|Request Rejected|HTTP ERROR 5\d\d/i.test(cuerpo)) {
      throw new Error('SUNAT devolvió error de servidor / corte del WAF. Esperá unos minutos.');
    }
    console.log('Login OK');

    etapa = 'abrir-modulo';
    const framesAntes = popup.frames().length;
    // `ejecuta()` es la función global del menú de SOL. El nivel1 se deriva del propio
    // código (11.38.1.1.1 → #nivel1_11).
    const nivel1 = `#nivel1_${codigo.split('.')[0]}`;
    const invocado = await popup.evaluate(({ codigo, nivel1 }) => {
      if (typeof window.ejecuta !== 'function') return 'sin-funcion';
      window.ejecuta(`MenuInternet.htm?action=iconExecute&code=${codigo}`, false, 'exploracion', nivel1, codigo);
      return 'ok';
    }, { codigo, nivel1 });
    console.log('ejecuta():', invocado);
    if (invocado === 'sin-funcion') throw new Error('La función ejecuta() no existe en esta página — el menú no cargó');

    // La SPA tarda en arrancar y recién DESPUÉS pega contra api-cpe. Esperar poco fue
    // el error de la corrida anterior: se cortó justo cuando aparecía el loader.
    const espera = Number(process.env.ESPERA_MS || 25000);
    console.log(`Esperando ${espera}ms a que la SPA haga sus llamadas...`);
    await popup.waitForTimeout(espera);

    etapa = 'modulo';
    console.log(`\nFrames: ${framesAntes} → ${popup.frames().length}`);
    const frames = await volcar(popup, ruc, `modulo-${codigo}`);

    console.log('\n================ URLs DE FRAMES ================');
    frames.forEach((f, i) => console.log(`  [${i}] ${f.url()}`));

    console.log('\n================ CONTROLES DEL MÓDULO ================');
    await inventariarControles(popup);

    console.log('\n================ LLAMADAS A api-cpe ================');
    if (!apiCpe.length) {
      console.log('  NINGUNA. La SPA no llegó a consultar — reintentar con ESPERA_MS=45000');
    } else {
      apiCpe.forEach((a) => {
        console.log(`  ${a.metodo} ${a.url}`);
        if (a.body) console.log(`      body: ${a.body}`);
      });
    }
    if (tokenPortal) {
      fs.writeFileSync(path.join(CARPETA, `token-portal-${ruc}.txt`), tokenPortal, 'utf8');
      console.log(`\n  Token del portal guardado (${tokenPortal.length} chars) en debug-cpe/token-portal-${ruc}.txt`);
    }

    console.log('\n================ RED (últimas 15) ================');
    red.slice(-15).forEach((r) => console.log(`  ${r.slice(0, 180)}`));

    console.log(`\nVolcados en storage-privado/debug-cpe/modulo-${codigo}-${ruc}*`);
  } catch (e) {
    console.error(`\nFALLÓ en etapa "${etapa}": ${e.message}`);
    if (pageActual) await volcar(pageActual, ruc, `error-${etapa}`).catch(() => {});
    console.log('\nRed capturada (últimas 20):');
    red.slice(-20).forEach((r) => console.log(`  ${r}`));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

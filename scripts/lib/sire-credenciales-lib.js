// Lógica compartida de extracción de Client ID/Secret SIRE desde el portal SUNAT.
// Usada tanto por registrar-credenciales-sire.js (una sola empresa, modo piloto/debug)
// como por procesar-lote-credenciales-sire.js (varias empresas, en tandas).
//
// Solo sabe LEER una aplicación YA REGISTRADA en el portal (ver Gestión Credenciales de
// API SUNAT) — si la empresa no tiene ninguna aplicación creada, retorna
// { ok:false, sinAplicacion:true } para que el caller la separe para revisión manual o
// para el flujo de registro nuevo (todavía no construido).
const { chromium } = require('playwright');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const CARPETA_DEBUG = path.join(process.cwd(), 'storage-privado', 'debug-sire');

function cifrar(textoPlano, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

async function screenshot(page, nombre) {
  fs.mkdirSync(CARPETA_DEBUG, { recursive: true });
  await page.screenshot({ path: path.join(CARPETA_DEBUG, `${nombre}.png`), fullPage: true }).catch(() => {});
}

// empresa: { id_empresa, ruc, usuarioSol, claveSol } — ya descifrados por el caller.
async function extraerCredencialesSire(empresa) {
  const prefijo = `emp${empresa.id_empresa}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 30_000 });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'es-PE',
    });
    const page = await context.newPage();

    await page.goto('https://www.sunat.gob.pe/sol.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      page.click('a[href*="tramiteConsulta"]'),
    ]);
    const login = popup;
    await login.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    await login.waitForTimeout(500);

    await login.fill('#txtRuc', empresa.ruc);
    await login.fill('#txtUsuario', empresa.usuarioSol);
    await login.fill('#txtContrasena', empresa.claveSol);

    const [respuestaLogin] = await Promise.all([
      login.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
      login.click('#btnAceptar'),
    ]);
    await login.waitForTimeout(2000);

    // Detección de clave/usuario SOL incorrectos — SUNAT muestra un mensaje de error en
    // la misma página de login en vez de navegar. Sin este chequeo, el script seguiría
    // clickeando en el vacío y terminaría con un error genérico confuso más adelante.
    const errorLogin = await login.locator('text=/usuario o clave.*incorrect|clave incorrecta|datos ingresados no son correctos/i').first().isVisible().catch(() => false);
    if (errorLogin) {
      await screenshot(login, `${prefijo}-ERROR-login`);
      return { ok: false, error: 'Usuario/clave SOL incorrectos (rechazado por SUNAT)' };
    }

    const TEXTOS_DESCARTABLES = ['Ver más tarde', 'Continuar sin confirmar', 'Finalizar'];
    for (let ronda = 0; ronda < 4; ronda++) {
      await login.waitForTimeout(1200);
      let clickeadoEstaRonda = false;
      for (const f of login.frames()) {
        for (const texto of TEXTOS_DESCARTABLES) {
          const boton = f.locator(`button:has-text("${texto}")`);
          const cnt = await boton.count().catch(() => 0);
          for (let i = 0; i < cnt; i++) {
            if (await boton.nth(i).isVisible().catch(() => false)) {
              await boton.nth(i).click({ force: true, timeout: 5_000 }).catch(() => {});
              clickeadoEstaRonda = true;
            }
          }
        }
      }
      if (!clickeadoEstaRonda) break;
    }
    await login.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await login.waitForTimeout(1500);

    // Confirmado en vivo (25/08/2026): tras el login por "tramiteConsulta" la ventana
    // se queda a veces clavada en la página puente de api-seguridad ("Bienvenidos a
    // SUNAT", 157 bytes con el `code` OAuth en la URL) y nunca redirige sola al menú.
    // El síntoma era engañoso: fallaba más abajo con "no se encontró Credenciales de
    // API SUNAT" cuando en realidad nunca había llegado al menú. La sesión ya está en
    // las cookies, así que entrar por URL directa al menú es determinístico.
    if (!login.url().includes('e-menu.sunat.gob.pe')) {
      await login.goto('https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm', {
        waitUntil: 'domcontentloaded', timeout: 30_000,
      }).catch(() => {});
      await login.waitForTimeout(3000);
    }

    const opcionesCredenciales = login.locator('text=Credenciales de API SUNAT');
    const totalOpciones = await opcionesCredenciales.count();
    let clickeadoCredenciales = false;
    for (let i = 0; i < totalOpciones; i++) {
      if (await opcionesCredenciales.nth(i).isVisible().catch(() => false)) {
        await opcionesCredenciales.nth(i).click({ force: true, timeout: 10_000 }).catch(() => {});
        clickeadoCredenciales = true;
        break;
      }
    }
    if (!clickeadoCredenciales) {
      await screenshot(login, `${prefijo}-ERROR-click-credenciales-api`);
      return { ok: false, error: 'No se encontró "Credenciales de API SUNAT" en el menú tras el login' };
    }
    await login.waitForTimeout(1000);

    let gestionEncontrada = false;
    for (let nivel = 0; nivel < 4; nivel++) {
      const gestion = login.locator('text=Gestión Credenciales de API SUNAT');
      const gestionCount = await gestion.count();
      for (let i = 0; i < gestionCount; i++) {
        if (await gestion.nth(i).isVisible().catch(() => false)) {
          await gestion.nth(i).click({ force: true, timeout: 10_000 }).catch(() => {});
          gestionEncontrada = true;
          break;
        }
      }
      if (gestionEncontrada) break;

      const repetidas = login.locator('text=Credenciales de API SUNAT');
      const totalRepetidas = await repetidas.count();
      let clickeoNivel = false;
      for (let i = totalRepetidas - 1; i >= 0; i--) {
        if (await repetidas.nth(i).isVisible().catch(() => false)) {
          await repetidas.nth(i).click({ force: true, timeout: 10_000 }).catch(() => {});
          clickeoNivel = true;
          break;
        }
      }
      await login.waitForTimeout(1000);
      if (!clickeoNivel) break;
    }
    await login.waitForTimeout(1500);
    await login.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await login.waitForTimeout(1500);

    if (!gestionEncontrada) {
      await screenshot(login, `${prefijo}-ERROR-sin-gestion-credenciales`);
      return { ok: false, error: 'No se llegó a la pantalla "Gestión Credenciales de API SUNAT"' };
    }

    let frameCredenciales = null;
    for (const f of login.frames()) {
      const cnt = await f.locator('#id-api').count().catch(() => 0);
      if (cnt > 0) { frameCredenciales = f; break; }
    }
    if (!frameCredenciales) {
      await screenshot(login, `${prefijo}-ERROR-sin-frame-formulario`);
      return { ok: false, error: 'No se encontró el frame con el formulario de credenciales (#id-api)' };
    }

    const clientId = (await frameCredenciales.locator('#id-api').inputValue().catch(() => '')).trim();
    const clientSecret = (await frameCredenciales.locator('#clave').inputValue().catch(() => '')).trim();
    if (!clientId || !clientSecret) {
      await screenshot(login, `${prefijo}-sin-aplicacion`);
      return { ok: false, sinAplicacion: true, error: 'Campos ID/CLAVE vacíos — esta empresa no tiene una aplicación SIRE registrada todavía en el portal SUNAT' };
    }

    const scopeSireActivo = await frameCredenciales
      .locator('.form-check:has(span.servico:has-text("MIGE RCE y RVIE"))')
      .locator('input[type="checkbox"]')
      .isChecked()
      .catch(() => false);

    return { ok: true, clientId, clientSecret, scopeSireActivo };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    await browser?.close().catch(() => {});
  }
}

module.exports = { extraerCredencialesSire, cifrar };

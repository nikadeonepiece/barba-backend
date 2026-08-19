// Piloto de registro automatizado de client_id/client_secret SIRE en el portal SUNAT.
// Uso: node scripts/registrar-credenciales-sire.js <RUC>
//
// Reutiliza el flujo de login YA VERIFICADO EN VIVO en
// apps/api/src/vencimientos/fase2/sunat-scraping.client.ts (multi-ventana + iframe,
// no una página plana). A partir de ahí navega el menú "EMPRESAS / Credenciales de
// API SUNAT / ... / Gestión Credenciales de API SUNAT" descrito en el manual oficial
// SIRE Compras (sección "I. Guía de Uso / 1. Servicio prerrequisito"), sin selectores
// verificados todavía — por eso guarda captura de pantalla en cada paso en
// storage-privado/debug-sire/ para poder revisar y ajustar si algo falla.
//
// NO corre en loop sobre varias empresas — un solo RUC por ejecución, a propósito
// (piloto supervisado, no tanda masiva).

require('dotenv').config();
const { chromium } = require('playwright');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const CARPETA_DEBUG = path.join(process.cwd(), 'storage-privado', 'debug-sire');

function descifrar(buffer, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

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

async function main() {
  const ruc = process.argv[2];
  if (!ruc) { console.error('Uso: node registrar-credenciales-sire.js <RUC>'); process.exit(1); }

  const key = process.env.CREDENCIALES_ENCRYPTION_KEY;
  if (!key) { console.error('Falta CREDENCIALES_ENCRYPTION_KEY en .env'); process.exit(1); }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  const [[empresa]] = await conn.query(
    `SELECT id_empresa, ruc, sunat_sol_usuario, sunat_sol_password FROM empresa WHERE ruc = ? AND estado_registro = 'ACTIVO'`,
    [ruc],
  );
  if (!empresa) { console.error('Empresa no encontrada'); await conn.end(); process.exit(1); }
  if (!empresa.sunat_sol_usuario || !empresa.sunat_sol_password) {
    console.error('Esta empresa no tiene usuario/clave SOL guardados');
    await conn.end(); process.exit(1);
  }

  const usuarioSol = descifrar(empresa.sunat_sol_usuario, key);
  const claveSol = descifrar(empresa.sunat_sol_password, key);

  await conn.query(
    `INSERT INTO sire_credenciales_registro (id_empresa, estado, id_usuario_crea)
     VALUES (?, 'EN_PROCESO', 1)
     ON DUPLICATE KEY UPDATE estado = 'EN_PROCESO', mensaje_error = NULL, fecha_intento = NOW()`,
    [empresa.id_empresa],
  );

  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 30_000 });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'es-PE',
    });
    const page = await context.newPage();

    // --- Login: mismo flujo verificado en sunat-scraping.client.ts, PERO por
    // "Mis Trámites y Consultas" (no "Mis Declaraciones y Pagos" — ese lleva a
    // "Declara Fácil", un sub-portal sin el menú "Empresas" que necesitamos aquí) ---
    await page.goto('https://www.sunat.gob.pe/sol.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await screenshot(page, '01-sol-html');
    // "Mis Trámites y Consultas" (href="javascript:tramiteConsulta()") — confirmado en
    // vivo (16/08/2026) contra el HTML real de sol.html — es el que lleva al menú
    // general con "Personas / Empresas / Operador de Comercio Exterior". El otro botón
    // ("Mis Declaraciones y Pagos" → declaraSimplificadaNueva()) lleva a "Declara
    // Fácil", un sub-portal sin el menú "Empresas" que necesitamos aquí.
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      page.click('a[href*="tramiteConsulta"]'),
    ]);
    const login = popup;
    await login.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    await login.waitForTimeout(500);
    await screenshot(login, '02-popup-login');
    fs.mkdirSync(CARPETA_DEBUG, { recursive: true });
    const html02 = await login.content().catch(() => null);
    if (html02) fs.writeFileSync(path.join(CARPETA_DEBUG, '02-popup-login.html'), html02);

    // Confirmado en vivo (16/08/2026): a diferencia del popup de
    // declaraSimplificadaNueva(), este login (tramiteConsulta) NO usa iframe — los
    // campos van directos en la página del popup. #btnPorRuc ya viene activo por
    // defecto (class="btn active btnPor"), no hace falta clickearlo.
    await login.fill('#txtRuc', empresa.ruc);
    await login.fill('#txtUsuario', usuarioSol);
    await login.fill('#txtContrasena', claveSol);

    await Promise.all([
      login.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
      login.click('#btnAceptar'),
    ]);
    await login.waitForTimeout(2000);
    await screenshot(login, '03-post-login');
    const html03 = await login.content().catch(() => null);
    if (html03) fs.writeFileSync(path.join(CARPETA_DEBUG, '03-post-login.html'), html03);

    // SUNAT muestra distintos popups post-login según el estado de la cuenta —
    // confirmado en vivo con 2 empresas reales, cada una mostró uno distinto:
    // "Valida tus datos de contacto" (→ "Continuar sin confirmar", luego un segundo
    // "Finalizar" de confirmación) y "Buzón Electrónico" (→ "Ver más tarde"). Ninguno
    // de los dos afecta el login ya hecho — son informativos, siempre seguros de
    // saltar. En vez de adivinar cuál va a salir, se cierra TODO lo que aparezca en
    // varias rondas, buscando en todos los frames, hasta que no quede ninguno.
    const TEXTOS_DESCARTABLES = ['Ver más tarde', 'Continuar sin confirmar', 'Finalizar'];
    for (let ronda = 0; ronda < 4; ronda++) {
      await login.waitForTimeout(1200);
      let clickeadoEstaRonda = false;
      for (const f of login.frames()) {
        for (const texto of TEXTOS_DESCARTABLES) {
          const boton = f.locator(`button:has-text("${texto}")`);
          const cnt = await boton.count().catch(() => 0);
          for (let i = 0; i < cnt; i++) {
            const visible = await boton.nth(i).isVisible().catch(() => false);
            if (visible) {
              console.log(`Ronda ${ronda}: clic en "${texto}"`);
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

    await screenshot(login, '04-tras-cerrar-popups');
    const html04 = await login.content().catch((e) => { console.error('No se pudo leer content:', e.message); return null; });
    if (html04) fs.writeFileSync(path.join(CARPETA_DEBUG, '04-tras-cerrar-popups.html'), html04);
    for (const [i, f] of login.frames().entries()) {
      const c = await f.content().catch(() => null);
      if (c) fs.writeFileSync(path.join(CARPETA_DEBUG, `04-frame-${i}.html`), c);
    }

    // Confirmado en vivo (16/08/2026): tras cerrar los popups, aterriza en el menú
    // general de SUNAT Operaciones en Línea con "Credenciales de API SUNAT" YA
    // visible directo en la lista (no hace falta pasar por la pestaña "Empresas").
    // El texto se repite 8 veces en el árbol del menú (submenús colapsados, ocultos) —
    // hay que clickear la primera ocurrencia VISIBLE, no la primera del DOM.
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
      await screenshot(login, 'ERROR-click-credenciales-api');
      throw new Error('No se encontró ninguna ocurrencia visible de "Credenciales de API SUNAT"');
    }
    await login.waitForTimeout(1000);

    // El manual repite "Credenciales de API SUNAT" varios niveles anidados antes de
    // "Gestión Credenciales de API SUNAT" — se sigue clickeando la ÚLTIMA ocurrencia
    // visible (la más recién desplegada) hasta que aparezca "Gestión...".
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
    console.log('¿Se encontró y clickeó "Gestión Credenciales de API SUNAT"?', gestionEncontrada);
    await login.waitForTimeout(1500);
    await login.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await login.waitForTimeout(1500);
    await screenshot(login, '06-tras-buscar-gestion-credenciales');
    if (!gestionEncontrada) {
      throw new Error('No se llegó a la pantalla "Gestión Credenciales de API SUNAT"');
    }

    // Confirmado en vivo (16/08/2026, vía dump estático de storage-privado/debug-sire/
    // 06-frame-4.html): el formulario Angular expone los campos como
    // <input id="id-api" disabled> / <input id="clave" disabled> — el valor NO aparece
    // en el HTML estático (Angular lo setea por property binding, no como atributo), por
    // eso hay que leerlo en vivo con .inputValue() sobre el frame real, no parseando el
    // dump. El checkbox del scope SIRE es <input type="checkbox" id="2"> con su label
    // <span class="servico">MIGE RCE y RVIE - SIRE</span> — el estado "marcado" tampoco
    // se ve en el HTML estático por la misma razón, se lee con la propiedad .checked.
    let frameCredenciales = null;
    for (const f of login.frames()) {
      const cnt = await f.locator('#id-api').count().catch(() => 0);
      if (cnt > 0) { frameCredenciales = f; break; }
    }
    if (!frameCredenciales) {
      throw new Error('No se encontró el frame con el formulario de Gestión Credenciales (#id-api)');
    }

    const clientId = (await frameCredenciales.locator('#id-api').inputValue().catch(() => '')).trim();
    const clientSecret = (await frameCredenciales.locator('#clave').inputValue().catch(() => '')).trim();
    if (!clientId || !clientSecret) {
      await screenshot(login, 'ERROR-credenciales-vacias');
      throw new Error('Los campos ID/CLAVE aparecen vacíos — la aplicación puede no estar registrada para esta empresa');
    }

    const scopeSireActivo = await frameCredenciales
      .locator('.form-check:has(span.servico:has-text("MIGE RCE y RVIE"))')
      .locator('input[type="checkbox"]')
      .isChecked()
      .catch(() => false);
    console.log('Scope "MIGE RCE y RVIE - SIRE" habilitado:', scopeSireActivo);

    await conn.query(
      `UPDATE empresa SET sunat_api_client_id = ?, sunat_api_client_secret = ? WHERE id_empresa = ?`,
      [cifrar(clientId, key), cifrar(clientSecret, key), empresa.id_empresa],
    );
    await conn.query(
      `UPDATE sire_credenciales_registro SET estado = 'EXITOSO', mensaje_error = ?, fecha_exito = NOW() WHERE id_empresa = ?`,
      [scopeSireActivo ? null : 'ADVERTENCIA: credenciales extraídas OK pero el scope "MIGE RCE y RVIE - SIRE" no está marcado en el portal — revisar manualmente', empresa.id_empresa],
    );
    console.log(`Credenciales SIRE guardadas para empresa ${empresa.ruc} (id_empresa=${empresa.id_empresa}).`);
    console.log(`client_id (primeros 8): ${clientId.slice(0, 8)}...`);

    await browser.close();
    await conn.end();
    return;
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    await conn.query(
      `UPDATE sire_credenciales_registro SET estado = 'ERROR', mensaje_error = ? WHERE id_empresa = ?`,
      [error.message, empresa.id_empresa],
    );
  } finally {
    await browser?.close().catch(() => {});
    await conn.end();
  }
}

main();

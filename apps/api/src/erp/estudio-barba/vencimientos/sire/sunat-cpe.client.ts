import { Injectable, Logger } from '@nestjs/common';
import { chromium, Browser, Page } from 'playwright';
import * as unzipper from 'unzipper';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Baja de SUNAT el XML de los comprobantes EMITIDOS y le extrae el detalle de ítems
 * (qué se vendió, cuánto y a qué precio) — lo único que el SIRE no trae.
 *
 * POR QUÉ EXISTE: el TXT del SIRE tiene 39 columnas a nivel comprobante y ninguna de
 * descripción/cantidad/precio (ver sire-parser.util.ts). Ese detalle solo vive en el
 * XML UBL, dentro de `cac:InvoiceLine`.
 *
 * VÍA ELEGIDA — verificada en vivo el 08/09/2026 contra RG TRANSPORTES:
 *   opción de menú SOL 11.5.3.1.2 "Consulta de Facturas y Notas Electrónicas"
 *   → https://ww1.sunat.gob.pe/ol-ti-itconscpemype/consultar.do
 *
 * Se descartaron antes, con evidencia:
 *  - API REST pública (`validarcomprobante`): solo valida estado, no descarga XML.
 *  - `api-cpe.sunat.gob.pe/v1/contribuyente/consultacpe`: existe y la empresa está
 *    autorizada (lo dice el claim `aud` del JWT que SOL le pasa a su SPA), pero no
 *    logramos dar con la ruta completa y su SPA está caída, así que no se puede
 *    aprender de ella. OJO: ese gateway responde 404 —no 403— cuando al token le
 *    falta el recurso, lo que despista mucho al tantear rutas.
 *  - Opción de menú 11.38.1.1.1 ("Nueva Consulta de comprobantes de pago"), que sería
 *    la general e incluiría COMPRAS: devuelve "ERROR 404 - PÁGINA NO DISPONIBLE" de
 *    SUNAT, también con navegador visible y sesión real. Está caída del lado de ellos.
 *    Conviene reintentarla cada tanto: si la reponen, sale también el detalle de compras.
 *
 * ⚠️ ALCANCE: este módulo de SOL solo tiene los comprobantes emitidos por SEE-SOL
 * (serie `E###`). Una empresa que emita con serie `F###` usa SEE propio u OSE y sus
 * XML NO están acá — para esas hay que integrar con su facturador. Por eso
 * `descargarItemsDeVentas` avisa cuando no encuentra nada en vez de fallar mudo.
 *
 * ⚠️ El navegador se abre en la máquina donde corre este proceso. En un hosting sin
 * Chromium ni $DISPLAY el `launch()` falla — se avisa con NavegadorCpeNoDisponibleError
 * para que quien llame ofrezca una alternativa en vez de morir con un 500 mudo.
 * Mismo criterio que catalogos/empresas/sunat-login.client.ts.
 */

export class NavegadorCpeNoDisponibleError extends Error {
  constructor(detalle?: string) {
    super(`No hay navegador disponible en este servidor para consultar SUNAT${detalle ? `: ${detalle}` : ''}`);
    this.name = 'NavegadorCpeNoDisponibleError';
  }
}

export interface ItemComprobante {
  nro_linea: number;
  codigo_producto: string | null;
  descripcion: string;
  cantidad: number;
  unidad_medida: string | null;
  precio_unitario: number;
  importe: number;
}

export interface ComprobanteConItems {
  tipo_doc: string;
  serie: string;
  numero: string;
  fecha_emision: string;
  ruc_receptor: string;
  razon_social_receptor: string;
  total: string;
  items: ItemComprobante[];
}

@Injectable()
export class SunatCpeClient {
  private readonly logger = new Logger(SunatCpeClient.name);

  /** Una vez que el launch falló por entorno vuelve a fallar siempre — no se reintenta. */
  private navegadorNoDisponible = false;

  private static readonly SELECTORES = {
    LOGIN_URL: 'https://www.sunat.gob.pe/sol.html',
    // Se entra por "Mis trámites y consultas": es la puerta con el menú COMPLETO. La de
    // "Mis Declaraciones y Pagos" deja la sesión encerrada en ese módulo y no llega acá
    // (ver el bloque SELECTORES de catalogos/empresas/sunat-login.client.ts).
    LINK_TRAMITES: 'a[href*="tramiteConsulta"]',
    BOTON_POR_RUC: '#btnPorRuc',
    IFRAME_URL_CONTIENE: 'api-seguridad.sunat.gob.pe',
    INPUT_RUC: '#txtRuc',
    INPUT_USUARIO: '#txtUsuario',
    INPUT_CLAVE: '#txtContrasena',
    BOTON_INGRESAR: '#btnAceptar',
  };

  /** Opción de menú y app destino. Van juntos: si SUNAT cambia una, cambia la otra. */
  private static readonly CODIGO_OPCION = '11.5.3.1.2';
  private static readonly APP_CONSULTA = 'ol-ti-itconscpemype';
  /**
   * tipoConsulta=10 → "FE Emitidas". El valor está en el HTML del módulo y devuelve
   * las FACTURAS del rango.
   *
   * ⚠️ PENDIENTE — notas de crédito y débito: el módulo se titula "Consultas Factura,
   * Nota de Crédito y Débito Electrónicas", así que deberían salir por acá, pero el
   * combo que elige el tipo lo llena Dojo en runtime y sus opciones no están en el HTML
   * estático. Se probaron 20/30/40/50 contra SUNAT (08/09/2026) y todos devolvieron
   * `codeError=1`; `action=datosInicial` por su cuenta da 404. Queda por descubrir cuál
   * es el parámetro correcto — mientras tanto, una NC aparece en la pantalla del SIRE
   * con `items: []`, no con datos equivocados.
   */
  private static readonly TIPO_CONSULTA_EMITIDAS = '10';

  /**
   * Devuelve los comprobantes emitidos en el rango, cada uno con sus ítems.
   * Las fechas van en DD/MM/AAAA, que es lo que espera el servlet.
   */
  async descargarItemsDeVentas(
    ruc: string, solUsuario: string, solPassword: string,
    fechaDesde: string, fechaHasta: string,
    maxComprobantes = 200,
  ): Promise<{ comprobantes: ComprobanteConItems[]; totalEncontrados: number }> {
    if (this.navegadorNoDisponible) throw new NavegadorCpeNoDisponibleError();

    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: true, timeout: 30_000 });
    } catch (error: any) {
      this.navegadorNoDisponible = true;
      this.logger.warn(`No se puede abrir un navegador acá (${error?.message}).`);
      throw new NavegadorCpeNoDisponibleError(error?.message);
    }

    let etapa = 'inicio';
    let pageDebug: Page | null = null;
    try {
      const context = await browser.newContext({
        // Sin User-Agent de navegador real SUNAT devuelve una página vacía antes de
        // llegar a cualquier selector (verificado en vivo, ver sunat-scraping.client.ts).
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        locale: 'es-PE',
        acceptDownloads: true,
      });

      etapa = 'login';
      const popup = await this.iniciarSesion(context, ruc, solUsuario, solPassword);
      pageDebug = popup;

      etapa = 'abrir-modulo';
      const app = await this.abrirModuloConsulta(popup);

      // Los fetch se hacen DESDE el frame del módulo: el servlet exige el `hc` de
      // sesión, que viaja en la query de la URL de ese frame, y las cookies de sesión.
      const query = app.url().split('?')[1] || '';

      etapa = 'consulta';
      const listado = await this.consultarComprobantes(app, query, fechaDesde, fechaHasta);
      if (!listado.length) {
        this.logger.warn(
          `RUC ${ruc}: SUNAT no devolvió comprobantes emitidos entre ${fechaDesde} y ${fechaHasta}. ` +
          'Si la empresa emite con serie F### (SEE propio u OSE), sus XML no están en este módulo.',
        );
        return { comprobantes: [], totalEncontrados: 0 };
      }

      etapa = 'descarga-xml';
      // `totalEncontrados` viaja junto a la lista: el tope existe para acotar el barrido,
      // pero si se aplica hay que poder AVISARLO. Devolver solo el array dejaba al
      // llamador sin forma de distinguir "el período tenía 200" de "tenía 300 y se
      // cortó", y el usuario se quedaba con un detalle incompleto sin saberlo.
      const salida: ComprobanteConItems[] = [];
      for (const cp of listado.slice(0, maxComprobantes)) {
        const xml = await this.descargarXml(app, query, ruc, cp);
        salida.push({ ...cp, items: xml ? SunatCpeClient.extraerItems(xml) : [] });
      }
      return { comprobantes: salida, totalEncontrados: listado.length };
    } catch (error: any) {
      const ruta = await this.guardarDebug(ruc, etapa, pageDebug);
      this.logger.error(
        `Falló la descarga de detalle CPE para RUC ${ruc} en etapa "${etapa}": ${error?.message}` +
        (ruta ? ` (volcado en ${ruta})` : ''),
      );
      throw error;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  /** Login SOL. Copiado de sunat-scraping.client.ts — ver ahí el porqué de cada paso. */
  private async iniciarSesion(context: any, ruc: string, usuario: string, clave: string): Promise<Page> {
    const s = SunatCpeClient.SELECTORES;
    const page: Page = await context.newPage();
    await page.goto(s.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      page.click(s.LINK_TRAMITES),
    ]);
    await popup.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    await popup.click(s.BOTON_POR_RUC).catch(() => {}); // puede venir ya seleccionado

    // El formulario vive en un IFRAME servido por api-seguridad: page.fill() no llega.
    const frame = popup.frames().find((f: any) => f.url().includes(s.IFRAME_URL_CONTIENE));
    if (!frame) throw new Error('No se encontró el iframe de login OAuth2 de SUNAT — el portal pudo haber cambiado');
    await frame.fill(s.INPUT_RUC, ruc);
    await frame.fill(s.INPUT_USUARIO, usuario);
    await frame.fill(s.INPUT_CLAVE, clave);

    const [respuesta] = await Promise.all([
      popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
      popup.click(s.BOTON_INGRESAR),
    ]);
    await popup.waitForTimeout(2500); // redirecciones OAuth2 posteriores al login

    // Sin esta comprobación el flujo "termina bien" con una pantalla de error y el
    // fallo aparece mucho después, como un selector que no existe.
    const cuerpo = (await popup.textContent('body').catch(() => '')) ?? '';
    const status = respuesta?.status() ?? 0;
    if (status >= 500 || /Request failed|Request Rejected|HTTP ERROR 5\d\d/i.test(cuerpo)) {
      const fallo: any = new Error(
        `SUNAT respondió con un error de su propio servidor al iniciar sesión (${status || 'oauth2/authen'}). ` +
        'No es un problema de usuario/clave SOL: suele pasar por saturación del portal o porque su WAF ' +
        'corta cuando se abren varias sesiones seguidas. Espera unos minutos y vuelve a intentar.',
      );
      fallo.errorDeSunat = true;
      throw fallo;
    }
    return popup;
  }

  /**
   * Abre el módulo de consulta. El menú de SOL NO navega por clics anidados: expone la
   * función global `ejecuta(url, flag, titulo, padre, codigo)` y cada opción lleva su
   * código en un `data-id`. Invocarla directo es mucho más robusto que abrir 4 niveles
   * de árbol, y no depende de que cada nivel esté visible.
   */
  private async abrirModuloConsulta(popup: Page) {
    const codigo = SunatCpeClient.CODIGO_OPCION;
    const invocado = await popup.evaluate((cod: string) => {
      const w = window as any;
      if (typeof w.ejecuta !== 'function') return false;
      w.ejecuta(`MenuInternet.htm?action=iconExecute&code=${cod}`, false, 'consulta', `#nivel1_${cod.split('.')[0]}`, cod);
      return true;
    }, codigo);
    if (!invocado) throw new Error('El menú de SOL no expuso ejecuta() — la sesión no llegó al menú');

    // El módulo carga en un iframe nuevo; se espera a que aparezca en vez de dormir fijo.
    const hasta = Date.now() + 30_000;
    while (Date.now() < hasta) {
      const app = popup.frames().find((f) => f.url().includes(SunatCpeClient.APP_CONSULTA));
      if (app) return app;
      await popup.waitForTimeout(1000);
    }
    throw new Error(
      `No cargó el módulo ${SunatCpeClient.APP_CONSULTA} (opción ${codigo}). ` +
      'Puede que SUNAT lo haya movido, o que el usuario SOL no tenga ese permiso.',
    );
  }

  /**
   * Lista los comprobantes emitidos del rango.
   *
   * ⚠️ El servlet NO devuelve una tabla HTML: devuelve un `<textarea>` con JSON, y su
   * campo `data` es a su vez un STRING con JSON adentro (doble codificación). Parsearlo
   * como HTML o hacer un solo JSON.parse no funciona.
   */
  private async consultarComprobantes(app: any, query: string, desde: string, hasta: string) {
    const html: string = await app.evaluate(
      async ({ query, desde, hasta, tipoConsulta }: any) => {
        const body = new URLSearchParams({
          action: 'realizarConsulta', buscarPor: 'porPer', estado: '1',
          fec_desde: desde, fec_hasta: hasta, tipoConsulta,
        });
        const r = await fetch(`consultar.do?${query}`, {
          method: 'POST', body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        return await r.text();
      },
      { query, desde, hasta, tipoConsulta: SunatCpeClient.TIPO_CONSULTA_EMITIDAS },
    );

    const enTextarea = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
    if (!enTextarea) throw new Error('La consulta de SUNAT no devolvió el <textarea> esperado — el servlet cambió de formato');
    const sobre = JSON.parse(enTextarea[1]);
    if (sobre.codeError && Number(sobre.codeError) !== 0) {
      throw new Error(`SUNAT rechazó la consulta (codeError=${sobre.codeError}): ${sobre.msgError || 'sin detalle'}`);
    }
    const filas = typeof sobre.data === 'string' ? JSON.parse(sobre.data) : (sobre.data || []);
    return filas
      // ind_puede_descargar=0 son comprobantes sin XML disponible: pedirlos da error.
      .filter((c: any) => c.ind_puede_descargar === '1')
      .map((c: any) => ({
        tipo_doc: c.codCpe,
        serie: c.nroSerie,
        numero: String(c.nroFactura),
        fecha_emision: c.fechaEmisionDesc,
        ruc_receptor: String(c.nroRucReceptor || '').trim(),
        razon_social_receptor: String(c.nroRucReceptorDesc || '').replace(/^\d+\s*-\s*/, ''),
        total: c.importeTotalDesc,
      }));
  }

  /** Pide el XML de un comprobante. Viene como ZIP; adentro está el .XML del UBL. */
  private async descargarXml(app: any, query: string, ruc: string, cp: any): Promise<string | null> {
    // page.evaluate() no puede devolver binario, así que el ZIP vuelve en base64.
    const res: any = await app.evaluate(
      async ({ query, ruc, cp }: any) => {
        const body = new URLSearchParams({
          action: 'descargarFactura', ruc, tipo: cp.tipo_doc, serie: cp.serie, numero: cp.numero,
        });
        const r = await fetch(`consultar.do?${query}`, {
          method: 'POST', body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const buf = await r.arrayBuffer();
        let s = '';
        new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
        return { status: r.status, datos: btoa(s) };
      },
      { query, ruc, cp },
    );
    if (res.status !== 200) {
      this.logger.warn(`SUNAT devolvió ${res.status} al pedir el XML de ${cp.serie}-${cp.numero}`);
      return null;
    }
    const buffer = Buffer.from(res.datos, 'base64');
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) { // "PK" → ZIP
      const dir = await unzipper.Open.buffer(buffer);
      const entrada = dir.files.find((f: any) => f.path.toLowerCase().endsWith('.xml'));
      if (!entrada) return null;
      return (await entrada.buffer()).toString('utf-8');
    }
    const texto = buffer.toString('utf-8');
    return texto.trimStart().startsWith('<?xml') ? texto : null;
  }

  /**
   * Extrae las líneas de detalle del XML UBL. Regex y no un parser XML a propósito:
   * es un formato fijo y acotado, y evita sumar una dependencia de parseo al backend.
   *
   * Las notas de crédito/débito usan `cac:CreditNoteLine` / `cac:DebitNoteLine` en vez
   * de `cac:InvoiceLine`, con los mismos hijos — por eso se aceptan las tres.
   */
  static extraerItems(xml: string): ItemComprobante[] {
    const bloques = xml.split(/<cac:(?:Invoice|CreditNote|DebitNote)Line>/).slice(1);
    return bloques.map((b, i) => {
      const g = (re: RegExp) => (b.match(re) || [])[1]?.trim();
      // Las descripciones vienen envueltas en CDATA — hay que desenvolverlas o el
      // texto llega como "<![CDATA[...]]>" literal a la pantalla.
      const limpiar = (v?: string) => (v || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
      const num = (v?: string) => {
        const n = parseFloat(v || '0');
        return isNaN(n) ? 0 : n;
      };
      const cantidadCruda = b.match(/<cbc:(?:Invoiced|Credited|Debited)Quantity([^>]*)>([\s\S]*?)<\/cbc:(?:Invoiced|Credited|Debited)Quantity>/);
      return {
        nro_linea: i + 1,
        codigo_producto: limpiar(g(/<cac:SellersItemIdentification>\s*<cbc:ID[^>]*>([\s\S]*?)<\/cbc:ID>/)) || null,
        descripcion: limpiar(g(/<cbc:Description[^>]*>([\s\S]*?)<\/cbc:Description>/)) || '(sin descripción)',
        cantidad: num(cantidadCruda?.[2]),
        unidad_medida: (cantidadCruda?.[1].match(/unitCode="([^"]*)"/) || [])[1] || null,
        precio_unitario: num(g(/<cbc:PriceAmount[^>]*>([\s\S]*?)<\/cbc:PriceAmount>/)),
        importe: num(g(/<cbc:LineExtensionAmount[^>]*>([\s\S]*?)<\/cbc:LineExtensionAmount>/)),
      };
    });
  }

  /**
   * Vuelca HTML + PNG de la pantalla donde falló. Va a storage-privado y NO a uploads/
   * porque el HTML de una sesión SOL logueada trae datos del contribuyente y uploads/
   * se sirve público sin login (ver main.ts). Nunca lanza: el error original es el que
   * tiene que llegar.
   */
  private async guardarDebug(ruc: string, etapa: string, page: Page | null): Promise<string | null> {
    if (!page || page.isClosed()) return null;
    try {
      const carpeta = path.join(process.cwd(), 'storage-privado', 'debug-cpe');
      fs.mkdirSync(carpeta, { recursive: true });
      const base = `error-${etapa}-${ruc}`;
      const html = await page.content().catch(() => '');
      if (html) fs.writeFileSync(path.join(carpeta, `${base}.html`), html, 'utf8');
      await page.screenshot({ path: path.join(carpeta, `${base}.png`), fullPage: true }).catch(() => {});
      return `storage-privado/debug-cpe/${base}.html`;
    } catch {
      return null;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { chromium, Browser, Page, Frame } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface LibroPlePresentado {
  numRuc: string;
  codLibro: string;
  codDescLibro: string;
  perAnioPreslib: string;
  perMesPreslib: string;
  fecPresentacion: string;
  indAtraso: string;
  numArchivoRes: string;
  annArchivoRes: string;
  codOportunidad?: string;
  indOperacion?: string;
  indMoneda?: string;
  indSimplificado?: string;
  codOrigen?: string;
}

/**
 * Cliente del PLE (Programa de Libros Electrónicos) en SUNAT Operaciones en Línea.
 *
 * POR QUÉ ESTO NO ES UNA API Y NO PUEDE SERLO: en PLE el contribuyente generaba el
 * TXT con su propio sistema y a SUNAT le enviaba solo un RESUMEN (hash). SUNAT nunca
 * tuvo las líneas del libro — solo la Constancia de Recepción. Por eso no hay
 * equivalente al flujo de ticket/ZIP del SIRE: acá se recuperan metadatos y el acuse
 * en PDF, y nada más. Para el detalle de comprobantes de un periodo pre-SIRE, el TXT
 * hay que subirlo desde el disco del cliente.
 *
 * VA EN ARCHIVO APARTE de `sunat-scraping.client.ts` a propósito: ese entra por
 * "Mis Declaraciones y Pagos" (declaraSimplificadaNueva → MenuInternetPlataforma.htm),
 * que es un menú ACOTADO desde el que no se llega a Libros. Este entra por "Mis
 * Trámites y Consultas" (tramiteConsulta → MenuInternet.htm), el menú completo. Y el
 * comentario de aquel archivo pide explícitamente no tocar la ruta que ya funciona.
 *
 * ✅ TODO LO DE ABAJO ESTÁ VERIFICADO EN VIVO (08/09/2026, RUC 20539814452), leyendo
 * el JS de la propia pantalla de SUNAT — ningún selector ni endpoint es una suposición:
 *
 *   1. Deep-link por código de opción: cada <li> del menú trae data-id="25.1.3.3.1" y
 *      el menú acepta ?exe= con ese mismo código. Se entra directo, sin encadenar los
 *      4 clicks del árbol — mucho más resistente a que SUNAT reacomode el menú.
 *   2. La app carga en un iframe cuya URL contiene "consLibElec".
 *   3. GET ./listaLibroGenerado → JSON. Es GET, NO POST: el $.ajax de la pantalla no
 *      declara `type` y el default de jQuery es GET; por POST SUNAT responde 405.
 *      La respuesta viene como JSON DENTRO de un string (la pantalla hace $.parseJSON).
 *   4. `numeroRuc` va fijo en "-1" — el RUC real sale de la sesión, no del parámetro.
 *      Consecuencia de diseño: una sesión de navegador POR EMPRESA, sin atajos.
 *   5. `codigoLibro` y `descripcionIndicador` van en "-" (guion) en la búsqueda
 *      general, no vacíos.
 *   6. El rango NO puede pasar de un año: la propia pantalla valida
 *      parseInt(AAAAMM_fin) - parseInt(AAAAMM_inicio) > 100. Por eso se consulta año
 *      por año y el llamador arma el historial completo.
 *   7. GET ./generarConstanciaRecepcion?numArchivoRes=..&annArchivoRes=.. → PDF real
 *      (content-type application/x-pdf, filename LE1103.pdf).
 */
@Injectable()
export class SunatPleClient {
  private readonly logger = new Logger(SunatPleClient.name);

  private static readonly LOGIN_URL = 'https://www.sunat.gob.pe/sol.html';
  private static readonly LINK_TRAMITES_CONSULTAS = 'a[href*="tramiteConsulta"]';
  private static readonly MENU_URL = 'https://e-menu.sunat.gob.pe/cl-ti-itmenucabina/MenuInternet.htm';
  private static readonly OPCION_CONSULTA_PLE = '25.1.3.3.1';
  private static readonly IFRAME_APP_CONTIENE = 'consLibElec';
  private static readonly IFRAME_LOGIN_CONTIENE = 'api-seguridad.sunat.gob.pe';

  /**
   * Abre una sesión SOL, entra a la pantalla de consulta PLE y ejecuta `accion` con el
   * frame de la app. Todo el trabajo va DENTRO del navegador porque los endpoints
   * dependen de la cookie de sesión SOL — replicarla fuera sería frágil y no aporta.
   */
  private async conSesionPle<T>(
    ruc: string,
    solUsuario: string,
    solPassword: string,
    accion: (app: Frame) => Promise<T>,
  ): Promise<T> {
    let browser: Browser | null = null;
    let paginaActiva: Page | null = null;
    let etapa = 'inicio';
    try {
      browser = await chromium.launch({ headless: true, timeout: 30_000 });
      // Sin un User-Agent de navegador real el WAF de SUNAT corta con "Request
      // Rejected" antes de llegar a cualquier selector (mismo motivo que en
      // sunat-scraping.client.ts, donde ya está verificado en vivo).
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 900 },
        locale: 'es-PE',
        acceptDownloads: true,
      });
      const page = await context.newPage();
      paginaActiva = page;

      etapa = 'menu-sol';
      await page.goto(SunatPleClient.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // "Mis Trámites y Consultas" no navega: abre una ventana nueva vía window.open.
      etapa = 'abrir-tramites';
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 20_000 }),
        page.click(SunatPleClient.LINK_TRAMITES_CONSULTAS),
      ]);
      paginaActiva = popup;
      await popup.waitForLoadState('domcontentloaded', { timeout: 30_000 });
      await popup.waitForTimeout(2_000);

      etapa = 'login';
      const frameLogin = popup.frames().find((f) => f.url().includes(SunatPleClient.IFRAME_LOGIN_CONTIENE));
      if (!frameLogin) throw new Error('No se encontró el iframe de login OAuth2 de SUNAT — el portal pudo haber cambiado');
      await frameLogin.fill('#txtRuc', ruc);
      await frameLogin.fill('#txtUsuario', solUsuario);
      await frameLogin.fill('#txtContrasena', solPassword);
      await Promise.all([
        popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => null),
        frameLogin.click('#btnAceptar'),
      ]);
      await popup.waitForTimeout(3_500);

      etapa = 'abrir-opcion-ple';
      await popup.goto(`${SunatPleClient.MENU_URL}?exe=${SunatPleClient.OPCION_CONSULTA_PLE}`, {
        waitUntil: 'domcontentloaded',
        timeout: 40_000,
      });
      await popup.waitForTimeout(6_000);

      const app = popup.frames().find((f) => f.url().includes(SunatPleClient.IFRAME_APP_CONTIENE));
      if (!app) {
        // Llegar acá casi siempre significa login rechazado (la pantalla siguiente es
        // el login de nuevo, o el modal de "valida tus datos de contacto"), no que la
        // opción no exista — por eso el volcado del catch es lo que resuelve el caso.
        throw new Error('No se llegó a la pantalla de consulta PLE — revisar el volcado de la etapa "abrir-opcion-ple"');
      }

      etapa = 'consulta';
      return await accion(app);
    } catch (error: any) {
      const pista = await this.guardarDebug(ruc, etapa, paginaActiva);
      this.logger.error(`PLE falló para RUC ${ruc} en la etapa "${etapa}": ${error?.message}`);
      throw new Error(
        `No se pudo consultar el PLE en SUNAT en la etapa "${etapa}": ${error?.message || 'error desconocido'}. ` +
        (pista ? `Pantalla volcada en ${pista} (HTML + captura). ` : '') +
        `Si el portal cambió, revisar los selectores en sunat-ple.client.ts.`,
      );
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  /**
   * Historial de libros presentados por PLE entre dos años, ambos inclusive.
   *
   * Se consulta año por año porque la pantalla rechaza rangos mayores a un año (ver
   * punto 6 del encabezado). Un año sin libros devuelve lista vacía y NO es un error:
   * es exactamente lo que pasa en los años en que la empresa ya estaba en SIRE, y es
   * el dato con el que `PleService` deduce el corte.
   */
  async listarLibros(
    ruc: string,
    solUsuario: string,
    solPassword: string,
    anioDesde: number,
    anioHasta: number,
  ): Promise<LibroPlePresentado[]> {
    return this.conSesionPle(ruc, solUsuario, solPassword, async (app) => {
      const todos: LibroPlePresentado[] = [];
      for (let anio = anioDesde; anio <= anioHasta; anio++) {
        const cruda = await app.evaluate(async (a: number) => {
          const params = new URLSearchParams({
            numeroRuc: '-1',
            anioIniPeriodo: String(a),
            mesIniPeriodo: '01',
            anioFinPeriodo: String(a),
            mesFinPeriodo: '12',
            codigoLibro: '-',
            descripcionIndicador: '-',
            codOrigen: '1',
          });
          const r = await fetch(`./listaLibroGenerado?${params.toString()}`, {
            method: 'GET',
            credentials: 'same-origin',
          });
          return { status: r.status, texto: await r.text() };
        }, anio);

        if (cruda.status !== 200) {
          this.logger.warn(`PLE ${ruc} año ${anio}: HTTP ${cruda.status} — se omite ese año`);
          continue;
        }
        try {
          // Doble parseo a propósito: SUNAT devuelve el JSON serializado DENTRO de un
          // string (la propia pantalla hace $.parseJSON sobre la respuesta).
          let data: any = JSON.parse(cruda.texto);
          if (typeof data === 'string') data = JSON.parse(data);
          const lista: LibroPlePresentado[] = Array.isArray(data?.lista) ? data.lista : [];
          todos.push(...lista);
        } catch {
          this.logger.warn(`PLE ${ruc} año ${anio}: respuesta no parseable — ${cruda.texto.slice(0, 150)}`);
        }
      }
      return todos;
    });
  }

  /**
   * Baja el PDF de la Constancia de Recepción. `numArchivoRes` + `annArchivoRes` son
   * el ÚNICO identificador con el que SUNAT la devuelve — sin los dos es irrecuperable.
   *
   * El PDF viaja como base64 desde el contexto de la página porque el endpoint exige la
   * cookie de sesión; `fetch` desde Node no la tiene.
   */
  async descargarConstancia(
    ruc: string,
    solUsuario: string,
    solPassword: string,
    numArchivoRes: string,
    annArchivoRes: string,
  ): Promise<Buffer> {
    return this.conSesionPle(ruc, solUsuario, solPassword, async (app) => {
      const r = await app.evaluate(async ([num, ann]: string[]) => {
        const resp = await fetch(`./generarConstanciaRecepcion?numArchivoRes=${num}&annArchivoRes=${ann}`, {
          credentials: 'same-origin',
        });
        const bytes = new Uint8Array(await resp.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return { status: resp.status, b64: btoa(bin) };
      }, [numArchivoRes, annArchivoRes]);

      if (r.status !== 200) throw new Error(`SUNAT devolvió HTTP ${r.status} al pedir la constancia ${numArchivoRes}/${annArchivoRes}`);
      const buffer = Buffer.from(r.b64, 'base64');
      // SUNAT responde 200 con una pantalla de error HTML cuando la sesión se cayó a
      // media descarga. Sin este chequeo se guardaría ese HTML con extensión .pdf y el
      // usuario recibiría un archivo roto sin ningún mensaje.
      if (buffer.subarray(0, 4).toString('latin1') !== '%PDF') {
        throw new Error(`SUNAT no devolvió un PDF para la constancia ${numArchivoRes}/${annArchivoRes} (¿sesión caída?)`);
      }
      return buffer;
    });
  }

  /**
   * Vuelca la pantalla donde murió el scraping (HTML + captura) para poder arreglar
   * selectores sin volver a gastar una sesión contra la cuenta real de un cliente.
   * Va en storage-privado y NO en uploads/, que se sirve público sin login (ver
   * main.ts): el HTML de una sesión SOL logueada trae datos del contribuyente.
   * Nunca lanza — si el volcado falla, el error original es lo que tiene que llegar.
   */
  private async guardarDebug(ruc: string, etapa: string, page: Page | null): Promise<string | null> {
    if (!page || page.isClosed()) return null;
    try {
      const carpeta = path.join(process.cwd(), 'storage-privado', 'debug-ple');
      fs.mkdirSync(carpeta, { recursive: true });
      const base = `${etapa}-${ruc}`;
      const html = await page.content().catch(() => '');
      if (html) fs.writeFileSync(path.join(carpeta, `${base}.html`), html, 'utf8');
      await page.screenshot({ path: path.join(carpeta, `${base}.png`), fullPage: true }).catch(() => {});
      return `storage-privado/debug-ple/${base}.html`;
    } catch {
      return null;
    }
  }
}

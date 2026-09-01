import { Injectable, Logger } from '@nestjs/common';
import { chromium, Page } from 'playwright';

/**
 * Abre una sesión de SUNAT YA LOGUEADA en un Chromium visible
 * (`headless: false`), para que el usuario siga navegando a mano — a
 * diferencia de `SunatScrapingClient` (vencimientos/sincronizacion-sunat), que es headless
 * y cierra el navegador al terminar. Selectores y advertencias del flujo de
 * login copiados de ahí (ver ese archivo para el detalle del porqué de cada
 * paso — multi-ventana + iframe OAuth2, no una página plana).
 *
 * Expone las DOS puertas de `sol.html`: "Mis Declaraciones y Pagos" y
 * "Mis trámites y consultas" (ver el bloque SELECTORES para por qué son
 * sesiones distintas y no se puede saltar de una a otra).
 *
 * ⚠️ El navegador se abre en la máquina donde corre este proceso Node — si
 * `erp-backend` corre en un servidor remoto sin pantalla, esta ventana nunca
 * la ve el usuario. Solo tiene sentido si el backend corre en la misma PC
 * desde la que se usa la app.
 *
 * A propósito NO se cierra el browser al terminar (el usuario lo sigue
 * usando) — solo se cierra si el login mismo falla, para no dejar procesos
 * de Chromium huérfanos acumulándose.
 */
@Injectable()
export class SunatLoginClient {
  private readonly logger = new Logger(SunatLoginClient.name);

  private static readonly SELECTORES = {
    LOGIN_URL: 'https://www.sunat.gob.pe/sol.html',

    // ⚠️ LA PUERTA IMPORTA: sol.html tiene varias, y cada una deja la sesión en una
    // aplicación DISTINTA del portal (verificado en vivo el 27/08/2026, ver
    // planilla/trabajadores/sunat-tregistro-scraping.client.ts):
    //
    //   javascript:declaraSimplificadaNueva() → cl-ti-itmenu2/MenuInternetPlataforma.htm?exe=55.1.1.1.1
    //       "Mis Declaraciones y Pagos". La sesión queda ENCERRADA en ese módulo:
    //       el menú lateral solo muestra su árbol.
    //
    //   javascript:tramiteConsulta()          → cl-ti-itmenucabina/MenuInternet.htm
    //       "Mis trámites y consultas": el menú COMPLETO de SOL (Empresas, Mi RUC y
    //       Otros Registros, T-Registro, etc.).
    //
    // No se puede saltar de una a otra por URL: cada app hace su propio handoff de
    // token por AutenticaMenuInternet.htm y rebota al login. Por eso son dos botones
    // separados en la UI y no uno solo que navegue después.
    LINK_DECLARA_SIMPLIFICADA: 'a[href*="declaraSimplificadaNueva"]',
    LINK_TRAMITES_CONSULTAS: 'a[href*="tramiteConsulta"]',

    BOTON_POR_RUC: '#btnPorRuc',
    IFRAME_URL_CONTIENE: 'api-seguridad.sunat.gob.pe',
    INPUT_RUC: '#txtRuc',
    INPUT_USUARIO: '#txtUsuario',
    INPUT_CLAVE: '#txtContrasena',
    BOTON_INGRESAR: '#btnAceptar',
  };

  /**
   * SUNAT abre el portal en un popup con tamaño fijo vía `window.open`, así que
   * `--start-maximized` (que sí aplica a la ventana inicial) no lo afecta.
   * Se maximiza a mano por CDP, que es la única vía desde Playwright.
   */
  private async maximizarVentana(page: Page): Promise<void> {
    try {
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
      await cdp.detach().catch(() => {});
    } catch (error: any) {
      // No es fatal: la sesión ya está abierta, solo queda con el tamaño por defecto.
      this.logger.warn(`No se pudo maximizar la ventana de SUNAT: ${error?.message}`);
    }
  }

  /** Abre "Mis Declaraciones y Pagos" ya logueado. */
  async abrirSesionMisDeclaraciones(ruc: string, solUsuario: string, solPassword: string): Promise<void> {
    return this.abrirSesion(
      ruc, solUsuario, solPassword,
      SunatLoginClient.SELECTORES.LINK_DECLARA_SIMPLIFICADA,
      'Mis Declaraciones y Pagos',
    );
  }

  /** Abre "Mis trámites y consultas" (menú completo de SOL) ya logueado. */
  async abrirSesionTramitesConsultas(ruc: string, solUsuario: string, solPassword: string): Promise<void> {
    return this.abrirSesion(
      ruc, solUsuario, solPassword,
      SunatLoginClient.SELECTORES.LINK_TRAMITES_CONSULTAS,
      'Mis trámites y consultas',
    );
  }

  /**
   * Flujo común de login. Lo único que cambia entre portales es el enlace de
   * `sol.html` por el que se entra (`linkEntrada`); el handshake OAuth2 posterior
   * es idéntico en ambos.
   */
  private async abrirSesion(
    ruc: string, solUsuario: string, solPassword: string,
    linkEntrada: string, nombrePortal: string,
  ): Promise<void> {
    const s = SunatLoginClient.SELECTORES;
    const browser = await chromium.launch({
      headless: false,
      timeout: 30_000,
      args: ['--start-maximized', '--window-position=0,0'],
    });
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: null, // sin viewport fijo la página ocupa toda la ventana maximizada
        locale: 'es-PE',
      });
      const page = await context.newPage();
      await page.goto(s.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 15_000 }),
        page.click(linkEntrada),
      ]);
      const login = popup;
      await login.waitForLoadState('domcontentloaded', { timeout: 20_000 });
      // Ojo: NO se maximiza acá. Redimensionar la ventana en medio del handshake
      // OAuth2 de SUNAT quedó bajo sospecha de un HTTP 500 en
      // /v1/clientessol/.../oauth2/authen, así que se hace recién post-login.

      await login.click(s.BOTON_POR_RUC).catch(() => {}); // puede ya venir seleccionado por defecto

      const frame = login.frames().find((f) => f.url().includes(s.IFRAME_URL_CONTIENE));
      if (!frame) throw new Error('No se encontró el iframe de login OAuth2 de SUNAT — el portal pudo haber cambiado');

      await frame.fill(s.INPUT_RUC, ruc);
      await frame.fill(s.INPUT_USUARIO, solUsuario);
      await frame.fill(s.INPUT_CLAVE, solPassword);

      const [respuesta] = await Promise.all([
        login.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
        login.click(s.BOTON_INGRESAR),
      ]);
      await login.waitForTimeout(1500); // margen para redirecciones OAuth2 posteriores al login

      // SUNAT a veces devuelve su propio 500 en /oauth2/authen (o el WAF corta con
      // "Request Rejected"). Sin esto el flujo "termina bien" y el usuario se queda
      // con una ventana de error abierta y sin explicación.
      const cuerpo = (await login.textContent('body').catch(() => '')) ?? '';
      const status = respuesta?.status() ?? 0;
      if (status >= 500 || /Request failed|Request Rejected|HTTP ERROR 5\d\d/i.test(cuerpo)) {
        const fallo: any = new Error(
          'SUNAT respondió con un error de su propio servidor al iniciar sesión ' +
          `(${status || 'oauth2/authen'}). No es un problema de usuario/clave SOL: suele pasar por ` +
          'saturación del portal o porque su WAF corta cuando se abren varias sesiones seguidas. ' +
          'Espera unos minutos y vuelve a intentar.',
        );
        fallo.errorDeSunat = true;
        throw fallo;
      }

      // El menú SOL puede volver a abrirse en otra ventana tras el login: se maximiza
      // la que quedó al frente para que el usuario no reciba un popup diminuto.
      await this.maximizarVentana(context.pages().at(-1) ?? login);

      // Sin cierre acá — el usuario sigue navegando en esta ventana.
    } catch (error: any) {
      this.logger.error(`No se pudo abrir "${nombrePortal}" de SUNAT para RUC ${ruc}: ${error?.message}`);
      await browser.close().catch(() => {});
      if (error?.errorDeSunat) throw error; // ya trae su propio mensaje, no aplica "revisa tu clave"
      throw new Error(
        `No se pudo iniciar sesión en SUNAT ("${nombrePortal}"): ${error?.message || 'error desconocido'}. ` +
        `Verifica usuario/clave SOL guardados, o si el portal cambió de diseño.`,
      );
    }
  }
}

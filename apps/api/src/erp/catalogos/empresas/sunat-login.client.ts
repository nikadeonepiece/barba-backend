import { Injectable, Logger } from '@nestjs/common';
import { chromium } from 'playwright';

/**
 * Abre una sesión de "Mis Declaraciones y Pagos" YA LOGUEADA en un Chromium
 * visible (`headless: false`), para que el usuario siga navegando a mano —
 * a diferencia de `SunatScrapingClient` (vencimientos/fase2), que es headless
 * y cierra el navegador al terminar. Selectores y advertencias del flujo de
 * login copiados de ahí (ver ese archivo para el detalle del porqué de cada
 * paso — multi-ventana + iframe OAuth2, no una página plana).
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
    LINK_DECLARA_SIMPLIFICADA: 'a[href*="declaraSimplificadaNueva"]',
    BOTON_POR_RUC: '#btnPorRuc',
    IFRAME_URL_CONTIENE: 'api-seguridad.sunat.gob.pe',
    INPUT_RUC: '#txtRuc',
    INPUT_USUARIO: '#txtUsuario',
    INPUT_CLAVE: '#txtContrasena',
    BOTON_INGRESAR: '#btnAceptar',
  };

  async abrirSesionMisDeclaraciones(ruc: string, solUsuario: string, solPassword: string): Promise<void> {
    const s = SunatLoginClient.SELECTORES;
    const browser = await chromium.launch({ headless: false, timeout: 30_000 });
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'es-PE',
      });
      const page = await context.newPage();
      await page.goto(s.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 15_000 }),
        page.click(s.LINK_DECLARA_SIMPLIFICADA),
      ]);
      const login = popup;
      await login.waitForLoadState('domcontentloaded', { timeout: 20_000 });

      await login.click(s.BOTON_POR_RUC).catch(() => {}); // puede ya venir seleccionado por defecto

      const frame = login.frames().find((f) => f.url().includes(s.IFRAME_URL_CONTIENE));
      if (!frame) throw new Error('No se encontró el iframe de login OAuth2 de SUNAT — el portal pudo haber cambiado');

      await frame.fill(s.INPUT_RUC, ruc);
      await frame.fill(s.INPUT_USUARIO, solUsuario);
      await frame.fill(s.INPUT_CLAVE, solPassword);

      await Promise.all([
        login.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
        login.click(s.BOTON_INGRESAR),
      ]);
      await login.waitForTimeout(1500); // margen para redirecciones OAuth2 posteriores al login

      // Sin cierre acá — el usuario sigue navegando en esta ventana.
    } catch (error: any) {
      this.logger.error(`No se pudo abrir sesión de SUNAT para RUC ${ruc}: ${error?.message}`);
      await browser.close().catch(() => {});
      throw new Error(
        `No se pudo iniciar sesión en SUNAT: ${error?.message || 'error desconocido'}. ` +
        `Verifica usuario/clave SOL guardados, o si el portal cambió de diseño.`,
      );
    }
  }
}

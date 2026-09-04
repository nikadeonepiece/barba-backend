import { Injectable, Logger } from '@nestjs/common';
import { chromium } from 'playwright';

/**
 * Abre una sesión de SUNAT SOL ya logueada, en un Chromium VISIBLE, para que el
 * usuario entre al T-Registro y consulte o descargue el padrón de trabajadores a mano.
 *
 * POR QUÉ ASÍ Y NO SCRAPING COMPLETO:
 * scrapear el T-Registro de punta a punta choca con dos cosas:
 *
 *   1. El WAF de SUNAT bloquea tras ~8 sesiones seguidas — ya documentado en
 *      `scripts/procesar-lote-credenciales-sire.js`. Con 171 empresas, un barrido
 *      automático lo dispara sí o sí.
 *   2. Los selectores de las pantallas internas del T-Registro no están verificados.
 *      Verificar los de "Mis Declaraciones" costó una sesión entera de inspección en
 *      vivo, y se rompen cuando SUNAT toca el portal.
 *
 * Con este enfoque, lo automatizado es lo caro y estable (el login OAuth2 multi-ventana
 * con iframe) y lo manual es lo barato y cambiante (navegar dos menús). El humano
 * además ve lo que está pasando, que en un portal de terceros vale bastante.
 *
 * ⚠️ El navegador se abre en la máquina donde corre este proceso Node. Si `erp-backend`
 * corre en un servidor remoto sin pantalla, esta ventana nunca la ve el usuario — igual
 * que el cliente equivalente de `catalogos/empresas`.
 *
 * Selectores del login copiados de `catalogos/empresas/sunat-login.client.ts`, que sí
 * están VERIFICADOS EN VIVO contra sunat.gob.pe. No se inyecta aquel service a
 * propósito: cada módulo usa el suyo (ver CLAUDE.md, sección 3).
 */
@Injectable()
export class SunatTregistroClient {
  private readonly logger = new Logger(SunatTregistroClient.name);

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

  async abrirSesionTregistro(ruc: string, solUsuario: string, solPassword: string): Promise<void> {
    const s = SunatTregistroClient.SELECTORES;
    const browser = await chromium.launch({ headless: false, timeout: 30_000 });

    try {
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'es-PE',
        // El T-Registro entrega reportes como descarga; sin esto Playwright las bloquea.
        acceptDownloads: true,
      });

      const page = await context.newPage();
      await page.goto(s.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // sol.html es un MENÚ público, no el login: el link dispara un javascript: que
      // abre una VENTANA NUEVA. Hay que esperar el evento 'page', no navegar.
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 15_000 }),
        page.click(s.LINK_DECLARA_SIMPLIFICADA),
      ]);
      const login = popup;
      await login.waitForLoadState('domcontentloaded', { timeout: 20_000 });

      await login.click(s.BOTON_POR_RUC).catch(() => {}); // a veces ya viene seleccionado

      // El formulario vive DENTRO de un iframe de api-seguridad.sunat.gob.pe (OAuth2):
      // page.fill() en la página padre no llega ahí.
      const frame = login.frames().find((f) => f.url().includes(s.IFRAME_URL_CONTIENE));
      if (!frame) {
        throw new Error('No se encontró el iframe de login OAuth2 de SUNAT — el portal pudo haber cambiado');
      }

      await frame.fill(s.INPUT_RUC, ruc);
      await frame.fill(s.INPUT_USUARIO, solUsuario);
      await frame.fill(s.INPUT_CLAVE, solPassword);

      // El botón de submit SÍ está en la página padre, no en el iframe.
      await Promise.all([
        login.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
        login.click(s.BOTON_INGRESAR),
      ]);
      await login.waitForTimeout(1500); // margen para las redirecciones OAuth2 posteriores

      this.logger.log(`Sesión SUNAT abierta para el RUC ${ruc} — el usuario navega al T-Registro a mano`);

      // A propósito NO se cierra el browser: el usuario sigue trabajando en esa ventana.
      // Tampoco se intenta navegar al T-Registro automáticamente — esos selectores no
      // están verificados y un click a ciegas dejaría al usuario en una pantalla
      // inesperada sin saber por qué.
    } catch (e) {
      // Solo se cierra si el login falló, para no dejar Chromium huérfanos acumulándose.
      await browser.close().catch(() => {});
      throw e;
    }
  }
}

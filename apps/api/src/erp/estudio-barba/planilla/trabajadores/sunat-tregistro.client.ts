import { Injectable, Logger } from '@nestjs/common';
import { chromium, Frame, Page } from 'playwright';

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
    // "Mis trámites y consultas", NO "Mis Declaraciones y Pagos". Entrando por
    // `declaraSimplificadaNueva` la sesión queda ENCERRADA en ese módulo y las opciones
    // del T-Registro no existen en el menú — o sea que este botón dejaba al usuario
    // justo donde no podía hacer lo que vino a hacer. Ver el comentario largo de
    // LINK_TRAMITES_CONSULTAS en sunat-tregistro-scraping.client.ts.
    LINK_TRAMITES_CONSULTAS: 'a[href*="tramiteConsulta"]',
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
        page.click(s.LINK_TRAMITES_CONSULTAS),
      ]);
      const login = popup;
      await login.waitForLoadState('domcontentloaded', { timeout: 20_000 });

      // TODO el formulario —RUC, Usuario, Contraseña, la pestaña RUC/DNI y el botón
      // "Iniciar sesión"— vive DENTRO del iframe de api-seguridad.sunat.gob.pe. Antes
      // se hacían el clic de la pestaña y el submit sobre la página padre, donde esos
      // elementos no existen: los dos caían al vacío y el `.catch(() => {})` lo tapaba.
      const frame = await this.esperarFrameLogin(login, s);

      await this.activarPestanaRuc(frame, s);

      await frame.fill(s.INPUT_RUC, ruc);
      await frame.fill(s.INPUT_USUARIO, solUsuario);
      await frame.fill(s.INPUT_CLAVE, solPassword);

      await this.verificarFormularioListo(frame);

      // El submit va DENTRO del iframe. Enviar el formulario desde otro documento es lo
      // que rompía el `state` del OAuth2 y hacía contestar a SUNAT
      // "Los parámetros de configuración de autenticación no coinciden".
      await Promise.all([
        login.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
        frame.click(s.BOTON_INGRESAR),
      ]);
      await login.waitForTimeout(1500).catch(() => {}); // margen para las redirecciones OAuth2

      // SUNAT manda acá cuando rechaza el login, y su pantalla cierra la ventana sola.
      // Sin este chequeo el flujo "terminaba bien" y el usuario se quedaba mirando
      // "DNI y/o contraseña son incorrectos" sin ninguna explicación del ERP.
      if (login.isClosed() || /\/oauth2\/error/i.test(login.url())) {
        throw new Error(
          'SUNAT rechazó el login de la Clave SOL. Verifica Usuario y Clave en ' +
          'Configuración → Empresas → Credenciales; si a mano entras bien, avisa porque ' +
          'entonces el problema es del ERP.',
        );
      }

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

  /**
   * Espera el iframe del login CON su formulario ya montado.
   *
   * No alcanza con `frames().find(...)`: la ventana sigue redirigiendo (cabina → login)
   * y el iframe puede existir antes que sus campos. Se exige ver el input del RUC.
   */
  private async esperarFrameLogin(
    login: Page, s: typeof SunatTregistroClient.SELECTORES,
  ): Promise<Frame> {
    const limite = Date.now() + 30_000;

    while (Date.now() < limite) {
      for (const f of login.frames()) {
        if (!f.url().includes(s.IFRAME_URL_CONTIENE)) continue;
        if (await f.locator(s.INPUT_RUC).count().catch(() => 0)) return f;
      }
      await login.waitForTimeout(500);
    }

    throw new Error(
      'No se encontró el formulario de login de SUNAT. Si al entrar a mano también falla, ' +
      'es del portal: limpia las cookies de sunat.gob.pe y vuelve a intentar.',
    );
  }

  /**
   * Deja el formulario en la pestaña "RUC" y lo COMPRUEBA.
   *
   * La pantalla son dos formularios: el visible (sin `action`, con #btnAceptar que es
   * `type="button"`) y el real, `LoginForm → j_security_check`, con campos ocultos. El
   * puente es la función `login()` de SUNAT, que setea `$("#tipo").val(tipoLogueo)`
   * — 1 = por DNI, 2 = por RUC.
   *
   * `tipoLogueo` solo cambia desde los handlers que jQuery ata en `inciaBotones()`, y
   * jQuery se descarga de OTRO host (jslibs1.sunat.gob.pe). Tocar el formulario antes
   * de eso hace que `tipo` viaje vacío y SUNAT conteste:
   *   "Falla en la autenticación. DNI y/o contraseña son incorrectos o no existen."
   * Un error de DNI en un login por RUC — que el 04/09/2026 mandó a revisar una Clave
   * SOL que estaba perfecta.
   */
  private async activarPestanaRuc(
    frame: Frame, s: typeof SunatTregistroClient.SELECTORES,
  ): Promise<void> {
    await frame
      .waitForFunction(
        () => {
          const w = window as any;
          if (typeof w.login !== 'function' || typeof w.tipoLogueo === 'undefined') return false;
          const btn = document.getElementById('btnPorRuc');
          if (!w.jQuery || !btn || !w.jQuery._data) return false;
          const eventos = w.jQuery._data(btn, 'events');
          return !!(eventos && eventos.click);
        },
        undefined,
        { timeout: 20_000 },
      )
      .catch(() => {});

    await frame.click(s.BOTON_POR_RUC).catch(() => {});

    const estado = await frame
      .evaluate(() => {
        const btn = document.getElementById('btnPorRuc');
        const filaDni = document.getElementById('divFilaDni');
        return {
          tipoLogueo: (window as any).tipoLogueo ?? null,
          activa: !!btn?.classList.contains('active'),
          dniOculto: !filaDni || getComputedStyle(filaDni).display === 'none',
        };
      })
      .catch(() => null);

    if (!estado || estado.tipoLogueo !== 2 || !estado.activa || !estado.dniOculto) {
      throw new Error(
        'El formulario de SUNAT no quedó en la pestaña "RUC" ' +
        `(tipoLogueo=${estado?.tipoLogueo ?? 'desconocido'}). Enviarlo así hace que SUNAT lo lea ` +
        'como login por DNI y conteste "DNI y/o contraseña son incorrectos", aunque la Clave SOL esté bien.',
      );
    }
  }

  /**
   * Relee el formulario justo antes de enviarlo.
   *
   * El handler de #btnPorRuc arranca llamando a `formularioReinicia()`, que VACÍA los
   * tres inputs; y `login()` valida del lado del cliente (usuario ≥ 8, clave ≥ 6) y no
   * envía nada si no se cumple, dejando la espera de navegación colgada hasta el
   * timeout. Solo se miran largos, nunca valores.
   */
  private async verificarFormularioListo(frame: Frame): Promise<void> {
    const estado = await frame
      .evaluate(() => {
        const largo = (id: string) =>
          ((document.getElementById(id) as HTMLInputElement | null)?.value ?? '').length;
        return { ruc: largo('txtRuc'), usuario: largo('txtUsuario'), clave: largo('txtContrasena') };
      })
      .catch(() => null);

    if (!estado) return;

    const problemas: string[] = [];
    if (estado.ruc !== 11) problemas.push(`el RUC quedó con ${estado.ruc} dígitos y SUNAT exige 11`);
    if (estado.usuario < 8) problemas.push(`el usuario quedó con ${estado.usuario} caracteres y SUNAT exige 8`);
    if (estado.clave < 6) problemas.push(`la clave quedó con ${estado.clave} caracteres y SUNAT exige 6`);

    if (problemas.length) {
      throw new Error(
        `El formulario no quedó listo para enviar: ${problemas.join('; ')}. No se envía, ` +
        'para no gastar un intento contra el WAF de SUNAT.',
      );
    }
  }
}

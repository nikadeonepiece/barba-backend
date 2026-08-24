import { Injectable, Logger } from '@nestjs/common';
import { chromium, Browser, Page, Frame } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface FilaBuzonSunat {
  bandeja: string | null;
  codigo_notificacion: string | null;
  tipo_documento: string | null;
  numero_documento: string | null;
  asunto: string | null;
  dependencia: string | null;
  fecha_deposito: string | null; // texto crudo del portal, se normaliza en el service
  leido_en_sunat: boolean;
  datos_crudos: Record<string, string>;
}

/**
 * BUZÓN ELECTRÓNICO DE SUNAT — lectura de la bandeja de notificaciones SOL de una
 * empresa cliente.
 *
 * ❓ ¿Por qué scraping y no API? — Se buscó API oficial primero (21/08/2026) y NO
 * existe para el buzón. SUNAT sí publica APIs REST para otras cosas (SIRE, ver
 * `sunat-sire.client.ts`; CPE; padrón RUC), pero para notificaciones SOL toda la
 * documentación oficial (orientacion.sunat.gob.pe/6619, gob.pe/7880) describe
 * únicamente el portal web y las apps móviles; no hay manual de servicio web ni
 * scope OAuth2 para esto. Lo único programático que ofrece SUNAT es el AVISO por
 * correo (gob.pe/7878), que solo dice "tienes una notificación" — sin contenido ni
 * PDF — así que no sirve para poblar la bandeja. Por eso Playwright, igual que
 * `SunatScrapingClient` (fase2) y `SunafilCasillaClient`.
 *
 * ✅ VERIFICADO CONTRA LOS SERVIDORES REALES (21/08/2026, sin usar Clave SOL de
 * ningún cliente): la app del buzón está desplegada en WebLogic bajo
 * `https://ww1.sunat.gob.pe/ol-ti-itbuzon/` — ese contexto contesta 403 del propio
 * WebLogic ("existe, pero exige sesión"), mientras que los nombres alternativos
 * probados (`ol-ti-itnotifica`, `ol-ti-itbuzonsol`, `ol-ti-itconsultanotificacion`,
 * `ol-ti-itbuzonelectronico`) los corta el nginx de borde con 404, o sea ni
 * siquiera están desplegados. De ahí sale `HOST_BUZON_CONTIENE`, que es cómo este
 * cliente reconoce que ya llegó al buzón (por URL, no por un selector de diseño).
 *
 * ✅ LOGIN — se reusa TAL CUAL el flujo ya verificado en vivo en
 * `sunat-scraping.client.ts` (multi-ventana + iframe OAuth2 de
 * `api-seguridad.sunat.gob.pe`). No se inventa una ruta nueva: ese recorrido ya
 * está confirmado contra SUNAT con una Clave SOL real, y duplicar la exploración
 * solo suma sesiones contra el WAF.
 *
 * ⚠️ NAVEGACIÓN AL BUZÓN Y SELECTORES DE LA BANDEJA — SIN CONFIRMAR EN VIVO. Para
 * llegar hace falta una Clave SOL real de una empresa cliente y el compromiso fue
 * no usar una sin supervisión. Por eso, en vez de un selector único inventado:
 *   - la entrada al buzón se intenta por VARIOS caminos en orden (link directo al
 *     contexto `ol-ti-itbuzon`, botón/opción con texto "Buzón electrónico", ícono
 *     con id/clase que contenga "buzon"), y sirve cualquiera que aterrice en el
 *     host correcto — no depende de que SUNAT conserve un `id` en particular;
 *   - la tabla se lee mapeando por TEXTO DE CABECERA, no por `td:nth-child(N)`
 *     (que asume un orden de columnas inventado y se rompe entero si SUNAT agrega
 *     una columna). Mismo criterio que `SunafilCasillaClient`.
 * Además cada corrida vuelca el HTML del menú y del buzón en
 * `storage-privado/debug-buzon-sunat/`, y la fila cruda completa va a
 * `sunat_buzon_notificacion.datos_crudos_json`: la primera corrida real contra una
 * empresa deja todo lo necesario para afinar este archivo sin volver a golpear el
 * portal.
 *
 * ⚠️ WAF — riesgo ya documentado en `sunat-scraping.client.ts`: tras ~8 sesiones
 * seguidas contra SUNAT en poco tiempo, el WAF empezó a cortar conexiones. La
 * sincronización masiva del service va con pausa entre empresas por eso mismo. No
 * convertir esto en un cron que recorra las 171 empresas varias veces al día.
 *
 * ⛔ DESCARGA DE ADJUNTOS — NO IMPLEMENTADA en esta fase (alcance acordado: listar
 * y guardar en BD). La columna `sunat_buzon_notificacion.archivo_ruta` ya existe
 * para cuando se agregue. Nota legal, distinta a la de SUNAFIL: en SUNAT el plazo
 * corre desde el día hábil siguiente al DEPÓSITO en el buzón, no desde que alguien
 * la abre — abrir la notificación no adelanta ningún plazo. O sea que acá la razón
 * para no descargar es de alcance, no de riesgo legal.
 */
@Injectable()
export class SunatBuzonClient {
  private readonly logger = new Logger(SunatBuzonClient.name);

  private static readonly SELECTORES = {
    // --- Login: idénticos a fase2, verificados en vivo contra SUNAT ---
    LOGIN_URL: 'https://www.sunat.gob.pe/sol.html',
    LINK_DECLARA_SIMPLIFICADA: 'a[href*="declaraSimplificadaNueva"]',
    BOTON_POR_RUC: '#btnPorRuc',
    IFRAME_LOGIN_URL_CONTIENE: 'api-seguridad.sunat.gob.pe',
    INPUT_RUC: '#txtRuc',
    INPUT_USUARIO: '#txtUsuario',
    INPUT_CLAVE: '#txtContrasena',
    BOTON_INGRESAR: '#btnAceptar',
    // --- Buzón: ✅ el contexto de la app está confirmado; ⚠️ cómo se entra, no ---
    HOST_BUZON_CONTIENE: 'ol-ti-itbuzon',
  };

  /**
   * Candidatos de entrada al buzón, en orden de preferencia: del más específico y
   * estable (un `href` que apunte al contexto real de la app, confirmado en vivo)
   * al más genérico (texto visible, que SUNAT puede reescribir). Se prueba uno por
   * uno y gana el primero que deje la sesión dentro del host del buzón.
   */
  private static readonly ENTRADAS_BUZON = [
    'a[href*="ol-ti-itbuzon"]',
    '[onclick*="buzon" i]',
    '[id*="buzon" i]',
    '[class*="buzon" i]',
    'text=/buz[oó]n electr[oó]nico/i',
    'text=/buz[oó]n/i',
  ];

  /**
   * Palabras clave por campo, en minúscula y sin tilde, para mapear cabeceras del
   * portal a nuestro modelo. Se compara por "la cabecera CONTIENE la palabra", así
   * que sirve tanto "Fecha" como "Fecha de depósito" o "Fecha de notificación".
   * El orden importa: gana la primera coincidencia, por eso `numero_documento` va
   * antes que `tipo_documento` (una cabecera "N° de documento" debe caer en el
   * número, no en el tipo).
   */
  private static readonly MAPA_CABECERAS: Array<{ campo: keyof FilaBuzonSunat; claves: string[] }> = [
    { campo: 'codigo_notificacion', claves: ['codigo', 'nro. notificacion', 'n° notificacion', 'numero de notificacion', 'cargo', 'constancia'] },
    { campo: 'numero_documento', claves: ['numero de documento', 'nro. documento', 'n° documento', 'nro documento'] },
    { campo: 'fecha_deposito', claves: ['fecha'] },
    { campo: 'tipo_documento', claves: ['tipo', 'documento'] },
    { campo: 'asunto', claves: ['asunto', 'sumilla', 'descripcion', 'detalle', 'mensaje'] },
    { campo: 'dependencia', claves: ['dependencia', 'intendencia', 'remitente', 'origen', 'emisor', 'area'] },
  ];

  async leerBuzon(ruc: string, solUsuario: string, solPassword: string): Promise<FilaBuzonSunat[]> {
    const s = SunatBuzonClient.SELECTORES;
    const browser: Browser = await chromium.launch({ headless: true, timeout: 30_000 });
    try {
      // Sin un User-Agent de navegador real el WAF de SUNAT responde "Request
      // Rejected" antes de servir nada (verificado en vivo en fase2).
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'es-PE',
      });
      const page = await context.newPage();

      await page.goto(s.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // "Mis Declaraciones y Pagos" no navega: dispara JS y abre una VENTANA NUEVA.
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 15_000 }),
        page.click(s.LINK_DECLARA_SIMPLIFICADA),
      ]);
      const login = popup;
      await login.waitForLoadState('domcontentloaded', { timeout: 20_000 });

      await login.click(s.BOTON_POR_RUC).catch(() => {}); // puede venir ya seleccionado

      const frameLogin = login.frames().find((f) => f.url().includes(s.IFRAME_LOGIN_URL_CONTIENE));
      if (!frameLogin) throw new Error('No se encontró el iframe de login OAuth2 de SUNAT — el portal pudo haber cambiado');

      await frameLogin.fill(s.INPUT_RUC, ruc);
      await frameLogin.fill(s.INPUT_USUARIO, solUsuario);
      await frameLogin.fill(s.INPUT_CLAVE, solPassword);

      await Promise.all([
        login.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
        login.click(s.BOTON_INGRESAR),
      ]);
      await login.waitForTimeout(2000); // margen para las redirecciones OAuth2 posteriores

      this.guardarDebug(ruc, 'menu', await login.content().catch(() => ''));

      const contextoBuzon = await this.entrarAlBuzon(context, login);
      const filas = await this.extraerFilas(contextoBuzon);

      this.guardarDebug(ruc, 'buzon', await contextoBuzon.content().catch(() => ''));

      return filas;
    } catch (error: any) {
      this.logger.error(`No se pudo leer el buzón SUNAT del RUC ${ruc}: ${error?.message}`);
      throw new Error(
        `No se pudo leer el Buzón Electrónico de SUNAT: ${error?.message || 'error desconocido'}. `
        + `Verifica la Clave SOL guardada para esta empresa, o si el portal cambió de diseño `
        + `(revisar los selectores en sunat-buzon.client.ts).`,
      );
    } finally {
      // Siempre se cierra: a diferencia de SunatLoginClient (que deja la ventana
      // abierta para que el usuario siga navegando), acá nadie mira la pantalla.
      await browser.close().catch(() => {});
    }
  }

  /**
   * Deja la sesión dentro del buzón y devuelve la Page donde vive.
   *
   * Prueba los candidatos de `ENTRADAS_BUZON` uno por uno; entre intento e intento
   * revisa si YA se llegó (el click puede abrir pestaña nueva, navegar la misma, o
   * cargar el buzón dentro de un iframe). Se valida por URL contra el contexto real
   * de la app (`ol-ti-itbuzon`, confirmado en vivo) y no por un texto de pantalla,
   * que es lo que SUNAT cambia seguido.
   */
  private async entrarAlBuzon(context: import('playwright').BrowserContext, menu: Page): Promise<Page> {
    const s = SunatBuzonClient.SELECTORES;

    const yaEstamos = () => this.paginaDelBuzon(context);

    const encontrada = yaEstamos();
    if (encontrada) return encontrada;

    for (const selector of SunatBuzonClient.ENTRADAS_BUZON) {
      try {
        const candidato = menu.locator(selector).first();
        if ((await candidato.count()) === 0) continue;

        // El click puede abrir una pestaña nueva (como pasa con el resto del portal
        // SOL) o navegar en la misma — se contemplan las dos sin asumir cuál.
        const esperarPestania = context.waitForEvent('page', { timeout: 8_000 }).catch(() => null);
        await candidato.click({ force: true, timeout: 8_000 });
        const nueva = await esperarPestania;
        if (nueva) await nueva.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => null);
        await menu.waitForTimeout(2500);

        const destino = yaEstamos();
        if (destino) {
          await destino.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null);
          this.logger.log(`Buzón SUNAT alcanzado con el selector "${selector}"`);
          return destino;
        }
      } catch {
        // Selector que no existe o no es clickeable en este diseño: se pasa al
        // siguiente candidato. Solo se falla si NINGUNO llegó (abajo).
      }
    }

    throw new Error(
      `No se pudo abrir el Buzón Electrónico desde el menú SOL (ninguna de las entradas conocidas llegó a "${s.HOST_BUZON_CONTIENE}"). `
      + `Revisar el HTML del menú volcado en storage-privado/debug-buzon-sunat/ para ver cómo se llama hoy esa opción.`,
    );
  }

  /**
   * Busca, entre todas las pestañas abiertas y sus iframes, alguna que esté dentro
   * del contexto de la app del buzón. Devuelve la Page contenedora (la extracción
   * recorre después todos sus frames, así que sirve igual si el buzón vive dentro
   * de un iframe del portal, que es como SUNAT sirve casi todas sus pantallas).
   */
  private paginaDelBuzon(context: import('playwright').BrowserContext): Page | null {
    const marca = SunatBuzonClient.SELECTORES.HOST_BUZON_CONTIENE;
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      if (p.url().includes(marca)) return p;
      if (p.frames().some((f) => f.url().includes(marca))) return p;
    }
    return null;
  }

  /**
   * Lee la bandeja mapeando por TEXTO DE CABECERA, no por posición de columna (ver
   * el porqué en el comentario de cabecera de la clase). Devuelve `[]` si no hay
   * tabla con filas — buzón vacío es un resultado válido, no un error: una empresa
   * al día puede no tener ninguna notificación.
   */
  private async extraerFilas(page: Page): Promise<FilaBuzonSunat[]> {
    // El contenido puede estar en la página o en cualquiera de sus iframes: se
    // evalúa en todos y gana el que traiga más filas.
    const marca = SunatBuzonClient.SELECTORES.HOST_BUZON_CONTIENE;
    const contextos: Array<Page | Frame> = [page, ...page.frames().filter((f) => f.url().includes(marca))];

    let mejor: { cabeceras: string[]; filas: string[][]; titulo: string } = { cabeceras: [], filas: [], titulo: '' };
    for (const ctx of contextos) {
      const leido = await ctx.evaluate(() => {
        const normalizar = (t: string | null | undefined) => (t || '').replace(/\s+/g, ' ').trim();

        // Se elige la tabla con más filas de datos: el portal SOL tiene además
        // tablas de layout/menú que no son la bandeja.
        const tablas = Array.from(document.querySelectorAll('table'));
        let elegida: HTMLTableElement | null = null;
        let maxFilas = 0;
        for (const t of tablas) {
          const n = t.querySelectorAll('tbody tr').length;
          if (n > maxFilas) { elegida = t as HTMLTableElement; maxFilas = n; }
        }
        if (!elegida || maxFilas === 0) return { cabeceras: [] as string[], filas: [] as string[][], titulo: '' };

        // Algunas pantallas de SUNAT no usan <thead>: si falta, se toma como
        // cabecera la primera fila que sea toda <th>.
        let cabeceras = Array.from(elegida.querySelectorAll('thead th, thead td')).map((c) => normalizar(c.textContent));
        if (cabeceras.length === 0) {
          const primera = elegida.querySelector('tr');
          if (primera && primera.querySelectorAll('th').length > 0) {
            cabeceras = Array.from(primera.querySelectorAll('th')).map((c) => normalizar(c.textContent));
          }
        }

        const filas = Array.from(elegida.querySelectorAll('tbody tr'))
          .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => normalizar(td.textContent)))
          .filter((celdas) => celdas.some((c) => c.length > 0));

        // Pestaña/carpeta activa del buzón, si el diseño la marca — sirve para
        // saber de qué bandeja salió cada fila (Notificaciones, Avisos, etc.).
        const activa = document.querySelector('.active, .ui-state-active, [aria-selected="true"]');
        return { cabeceras, filas, titulo: normalizar(activa?.textContent).slice(0, 100) };
      }).catch(() => ({ cabeceras: [] as string[], filas: [] as string[][], titulo: '' }));

      if (leido.filas.length > mejor.filas.length) mejor = leido;
    }

    if (mejor.filas.length === 0) return [];

    const indicePorCampo = this.mapearCabeceras(mejor.cabeceras);
    const bandeja = mejor.titulo || null;

    return mejor.filas.map((celdas) => {
      const datos_crudos: Record<string, string> = {};
      celdas.forEach((valor, i) => {
        const clave = mejor.cabeceras[i] || `columna_${i + 1}`;
        datos_crudos[clave] = valor;
      });

      const leer = (campo: keyof FilaBuzonSunat): string | null => {
        const i = indicePorCampo[campo as string];
        const valor = i !== undefined ? celdas[i] : undefined;
        return valor ? valor : null;
      };

      // El portal marca lo no leído con negrita/ícono, no con texto — no es
      // recuperable de forma confiable desde el texto plano. Se asume NO leído y el
      // seguimiento real lo lleva el estudio en `estado_gestion`. Ojo: esto no
      // afecta plazos, que en SUNAT corren desde el depósito, no desde la lectura.
      const textoFila = celdas.join(' ').toLowerCase();
      const leido_en_sunat = textoFila.includes('leido') || textoFila.includes('leído');

      return {
        bandeja,
        codigo_notificacion: leer('codigo_notificacion'),
        tipo_documento: leer('tipo_documento'),
        numero_documento: leer('numero_documento'),
        asunto: leer('asunto'),
        dependencia: leer('dependencia'),
        fecha_deposito: leer('fecha_deposito'),
        leido_en_sunat,
        datos_crudos,
      };
    });
  }

  private mapearCabeceras(cabeceras: string[]): Record<string, number> {
    const sinTilde = (t: string) =>
      t.normalize('NFD').split('').filter((c) => { const n = c.charCodeAt(0); return n < 0x300 || n > 0x36f; }).join('').toLowerCase();
    const indicePorCampo: Record<string, number> = {};
    const usados = new Set<number>();

    for (const { campo, claves } of SunatBuzonClient.MAPA_CABECERAS) {
      const i = cabeceras.findIndex((cab, idx) => !usados.has(idx) && claves.some((k) => sinTilde(cab).includes(k)));
      if (i >= 0) {
        indicePorCampo[campo as string] = i;
        usados.add(i);
      }
    }
    return indicePorCampo;
  }

  /**
   * Deja en disco el HTML del menú y del buzón para poder confirmar los selectores
   * tras la primera corrida real, sin volver a golpear el portal (WAF). Carpeta
   * PRIVADA: es una sesión SUNAT logueada de un cliente, en `uploads/` quedaría
   * descargable sin login. Best-effort: si falla escribir, NUNCA debe tumbar la
   * sincronización.
   */
  private guardarDebug(ruc: string, etapa: string, html: string) {
    if (!html) return;
    try {
      const carpeta = path.join(process.cwd(), 'storage-privado', 'debug-buzon-sunat');
      fs.mkdirSync(carpeta, { recursive: true });
      fs.writeFileSync(path.join(carpeta, `${etapa}-${ruc}.html`), html, 'utf8');
    } catch (e: any) {
      this.logger.warn(`No se pudo guardar el HTML de depuración del buzón SUNAT (${etapa}): ${e?.message}`);
    }
  }
}

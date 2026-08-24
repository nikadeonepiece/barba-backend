import { Injectable, Logger } from '@nestjs/common';
import { chromium, Browser, Page, Frame } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface FilaCasillaSunafil {
  codigo_notificacion: string | null;
  tipo_documento: string | null;
  asunto: string | null;
  numero_expediente: string | null;
  remitente: string | null;
  fecha_deposito: string | null; // texto crudo del portal, se normaliza en el service
  leido_en_sunafil: boolean;
  datos_crudos: Record<string, string>;
}

/**
 * CASILLA ELECTRÓNICA DE SUNAFIL — lectura de la bandeja del EMPLEADOR.
 *
 * ❓ ¿Por qué scraping y no API? — Se buscó API oficial primero (20/08/2026) y NO
 * existe: `https://casillaelectronica.sunafil.gob.pe/si.inbox/` responde con
 * `X-Powered-By: JSF/2.0` sobre Apache-Coyote y `javax.faces.ViewState` en el
 * formulario, o sea una app JSF/PrimeFaces server-rendered con estado de sesión —
 * no hay endpoints REST/JSON, no hay portal de desarrolladores, no hay
 * client_id/secret como sí lo hay para SIRE. Reproducir el protocolo JSF a mano
 * (postbacks con ViewState + ajax parcial) sería MÁS frágil que manejar el
 * navegador, por eso Playwright, igual que `SunatScrapingClient` de sincronizacion-sunat.
 *
 * ✅ LOGIN VERIFICADO CONTRA LOS SERVIDORES REALES (20/08/2026, leyendo el HTML
 * servido — sin usar todavía una Clave SOL de cliente):
 *   1. La portada del inbox tiene 3 botones (EMPLEADOR / TRABAJADOR / INTERNO).
 *      "EMPLEADOR" no es un link: ejecuta `ingresarEmpleador()`, que abre una
 *      VENTANA NUEVA hacia `/si.inbox/Login/SUNAT`.
 *   2. `/si.inbox/Login/SUNAT` es solo una página puente ("Bienvenido, cargando
 *      CLAVE SOL de SUNAT...") que tras 2 segundos hace
 *      `window.location.replace()` a la URL OAuth2 de SUNAT que se arma abajo.
 *   3. O sea: **el empleador NO tiene clave propia de SUNAFIL** — se entra con la
 *      misma Clave SOL de SUNAT que ya guardamos cifrada en `empresa`.
 *   4. Por eso este cliente va DIRECTO a la URL OAuth2 (`construirUrlLogin()`), saltándose
 *      los pasos 1-2: sin popup, sin espera artificial de 2s, y sin depender de
 *      que SUNAFIL no le cambie el `onclick` a sus botones. El `redirect_uri`
 *      (`/si.inbox/Login/Empresa`) es el que devuelve la sesión ya creada en la
 *      casilla, así que el resultado es idéntico al del flujo por pantalla.
 *
 * ⚠️ SELECTORES DEL INBOX — SIN CONFIRMAR EN VIVO. Para llegar a la bandeja hace
 * falta una Clave SOL real de una empresa cliente, y el compromiso fue no usar
 * una sin supervisión. Por eso la lectura de la tabla NO usa `td:nth-child(N)`
 * (que asume un orden de columnas inventado y se rompe entero si SUNAFIL agrega
 * una columna), sino un **mapeo por texto de cabecera**: se lee el `<thead>`, se
 * asocia cada columna con el campo del dominio por palabra clave, y se arma la
 * fila con eso. Si SUNAFIL cambia el orden de columnas esto sigue funcionando;
 * solo se rompe si cambia el vocabulario de las cabeceras. Además cada corrida
 * guarda el HTML de la bandeja en `storage-privado/debug-sunafil/` y la fila
 * cruda completa va a `sunafil_notificacion.datos_crudos_json`, así que la
 * primera corrida real contra una empresa deja todo lo necesario para ajustar
 * este archivo sin volver a golpear el portal.
 *
 * ⚠️ WAF — mismo riesgo documentado en `sunat-scraping.client.ts`: el login pasa
 * por `api-seguridad.sunat.gob.pe`, la MISMA infraestructura que ahí empezó a
 * cortar conexiones tras ~8 sesiones seguidas. La sincronización masiva del
 * service va con pausa entre empresas por eso mismo. No convertir esto en un
 * cron que recorra las 171 empresas varias veces al día.
 *
 * ⛔ DESCARGA DE ADJUNTOS — NO IMPLEMENTADA a propósito, y no por falta de
 * tiempo. Bajar el PDF exige abrir cada notificación en el portal, y abrirla la
 * marca como LEÍDA ante SUNAFIL, lo que **dispara el cómputo del plazo legal**
 * para responder. Que un job automático inicie plazos legales de un cliente sin
 * que nadie lo decida es un riesgo del estudio, no una decisión técnica. La
 * columna `sunafil_notificacion.archivo_ruta` ya existe para cuando el estudio
 * defina esa política; el flujo de lectura de la bandeja (esto) no abre nada.
 */
@Injectable()
export class SunafilCasillaClient {
  private readonly logger = new Logger(SunafilCasillaClient.name);

  // client_id público de SUNAFIL leído del propio bridge `/si.inbox/Login/SUNAT`
  // (20/08/2026). No es un secreto: viaja en el JS de una página pública. Queda
  // como variable de entorno para poder corregirlo sin desplegar código si
  // SUNAFIL rota su aplicación en SUNAT.
  private static readonly CLIENT_ID_POR_DEFECTO = 'b6474e23-8a3b-4153-b301-dafcc9646250';
  private static readonly REDIRECT_URI = 'https://casillaelectronica.sunafil.gob.pe/si.inbox/Login/Empresa';

  // Se lee `process.env` acá y no en un campo estático: los campos estáticos se
  // evalúan al importar el archivo, lo que puede ocurrir ANTES de que se cargue
  // el .env — la variable quedaría ignorada de forma silenciosa.
  private construirUrlLogin(): string {
    const cid = process.env.SUNAFIL_CASILLA_CLIENT_ID || SunafilCasillaClient.CLIENT_ID_POR_DEFECTO;
    return `https://api-seguridad.sunat.gob.pe/v1/clientessol/${cid}/oauth2/authen`
      + `?client_id=${cid}&response_type=code&state=s&redirect_uri=${SunafilCasillaClient.REDIRECT_URI}`;
  }

  private static readonly SELECTORES = {
    // --- Login SOL: mismos ids que ya usa sincronizacion-sunat, servidos por api-seguridad.sunat.gob.pe ---
    INPUT_RUC: '#txtRuc',
    INPUT_USUARIO: '#txtUsuario',
    INPUT_CLAVE: '#txtContrasena',
    BOTON_INGRESAR: '#btnAceptar',
    // --- Bandeja: ⚠️ sin confirmar en vivo (ver comentario de cabecera) ---
    HOST_CASILLA: 'casillaelectronica.sunafil.gob.pe',
  };

  /**
   * Palabras clave por campo, en minúscula y sin tilde, para mapear cabeceras del
   * portal a nuestro modelo. Se compara por "la cabecera CONTIENE la palabra",
   * así que sirve tanto "Fecha" como "Fecha de notificación" o "Fecha depósito".
   * El orden importa: gana la primera coincidencia, por eso `expediente` va antes
   * que `documento` (una cabecera "N° Documento del expediente" debe caer en
   * expediente, no en tipo_documento).
   */
  private static readonly MAPA_CABECERAS: Array<{ campo: keyof FilaCasillaSunafil; claves: string[] }> = [
    { campo: 'numero_expediente', claves: ['expediente', 'orden de inspeccion', 'orden inspeccion'] },
    { campo: 'fecha_deposito', claves: ['fecha'] },
    { campo: 'codigo_notificacion', claves: ['codigo', 'numero de notificacion', 'nro. notificacion', 'n° notificacion', 'cargo'] },
    { campo: 'tipo_documento', claves: ['tipo', 'documento'] },
    { campo: 'asunto', claves: ['asunto', 'sumilla', 'descripcion', 'detalle'] },
    { campo: 'remitente', claves: ['remitente', 'intendencia', 'dependencia', 'origen', 'emisor'] },
  ];

  async leerBandeja(ruc: string, solUsuario: string, solPassword: string): Promise<FilaCasillaSunafil[]> {
    const s = SunafilCasillaClient.SELECTORES;
    const browser: Browser = await chromium.launch({ headless: true, timeout: 30_000 });
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'es-PE',
      });
      const page = await context.newPage();

      await page.goto(this.construirUrlLogin(), { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // El formulario de SOL puede venir en la página o dentro de un iframe según
      // cómo SUNAT sirva la pantalla ese día — sincronizacion-sunat lo encontró en un iframe
      // llegando desde sol.html; entrando directo suele venir plano. Se resuelve
      // el contexto en vez de asumir uno de los dos.
      const contexto = await this.ubicarContextoLogin(page, s.INPUT_RUC);

      await contexto.fill(s.INPUT_RUC, ruc);
      await contexto.fill(s.INPUT_USUARIO, solUsuario);
      await contexto.fill(s.INPUT_CLAVE, solPassword);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
        page.click(s.BOTON_INGRESAR).catch(() => contexto.click(s.BOTON_INGRESAR)),
      ]);

      // Tras el submit hay una cadena de redirecciones OAuth2 hasta aterrizar en
      // SUNAFIL. Se espera por el HOST destino, no por un tiempo fijo.
      await page.waitForURL((url) => url.hostname.includes(s.HOST_CASILLA), { timeout: 45_000 }).catch(() => null);

      if (!page.url().includes(s.HOST_CASILLA)) {
        throw new Error(
          `El login no llegó a la casilla de SUNAFIL (quedó en ${page.url()}). `
          + `Suele ser Clave SOL incorrecta/vencida, o que el RUC no tiene casilla asignada todavía.`,
        );
      }

      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null);

      const html = await page.content();
      this.guardarDebug(ruc, html);

      return await this.extraerFilas(page);
    } catch (error: any) {
      this.logger.error(`No se pudo leer la casilla SUNAFIL del RUC ${ruc}: ${error?.message}`);
      throw new Error(
        `No se pudo leer la casilla electrónica de SUNAFIL: ${error?.message || 'error desconocido'}. `
        + `Verifica la Clave SOL guardada para esta empresa, o si el portal cambió de diseño.`,
      );
    } finally {
      // Siempre se cierra: a diferencia de SunatLoginClient (que deja la ventana
      // abierta para que el usuario siga navegando), acá nadie mira la pantalla.
      await browser.close().catch(() => {});
    }
  }

  /**
   * Devuelve la Page o el Frame donde vive realmente el formulario de Clave SOL.
   * Sin esto, un `page.fill()` contra un campo que está dentro del iframe de
   * `api-seguridad` falla con "selector no encontrado" aunque el campo se vea.
   */
  private async ubicarContextoLogin(page: Page, selectorRuc: string): Promise<Page | Frame> {
    const enLaPagina = await page.locator(selectorRuc).count().catch(() => 0);
    if (enLaPagina > 0) return page;

    for (const frame of page.frames()) {
      const encontrado = await frame.locator(selectorRuc).count().catch(() => 0);
      if (encontrado > 0) return frame;
    }
    throw new Error('No se encontró el formulario de Clave SOL (ni en la página ni en sus iframes) — el portal pudo haber cambiado');
  }

  /**
   * Lee la bandeja mapeando por TEXTO DE CABECERA, no por posición de columna
   * (ver el porqué en el comentario de cabecera de la clase). Devuelve `[]` si no
   * hay tabla — bandeja vacía es un resultado válido, no un error: una empresa
   * sin procedimientos abiertos no tiene nada notificado.
   */
  private async extraerFilas(page: Page): Promise<FilaCasillaSunafil[]> {
    const crudas = await page.evaluate(() => {
      const normalizar = (t: string | null | undefined) =>
        (t || '').replace(/\s+/g, ' ').trim();

      // Se elige la tabla con más filas de datos: los portales JSF suelen tener
      // tablas de layout/menú además de la de contenido.
      const tablas = Array.from(document.querySelectorAll('table'));
      let mejor: HTMLTableElement | null = null;
      let mejorFilas = 0;
      for (const t of tablas) {
        const n = t.querySelectorAll('tbody tr').length;
        if (n > mejorFilas) { mejor = t as HTMLTableElement; mejorFilas = n; }
      }
      if (!mejor || mejorFilas === 0) return { cabeceras: [] as string[], filas: [] as string[][] };

      const cabeceras = Array.from(mejor.querySelectorAll('thead th, thead td')).map((th) => normalizar(th.textContent));
      const filas = Array.from(mejor.querySelectorAll('tbody tr'))
        .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => normalizar(td.textContent)))
        .filter((celdas) => celdas.some((c) => c.length > 0));

      return { cabeceras, filas };
    });

    if (crudas.filas.length === 0) return [];

    const indicePorCampo = this.mapearCabeceras(crudas.cabeceras);

    return crudas.filas.map((celdas) => {
      const datos_crudos: Record<string, string> = {};
      celdas.forEach((valor, i) => {
        const clave = crudas.cabeceras[i] || `columna_${i + 1}`;
        datos_crudos[clave] = valor;
      });

      const leer = (campo: keyof FilaCasillaSunafil): string | null => {
        const i = indicePorCampo[campo as string];
        const valor = i !== undefined ? celdas[i] : undefined;
        return valor ? valor : null;
      };

      // El portal marca lo no leído en negrita/ícono, no en texto — no es
      // recuperable de forma confiable desde el texto plano. Se asume NO leído y
      // el estado real de gestión lo lleva el estudio en `estado_gestion`.
      const textoFila = celdas.join(' ').toLowerCase();
      const leido_en_sunafil = textoFila.includes('leido') || textoFila.includes('leído');

      return {
        codigo_notificacion: leer('codigo_notificacion'),
        tipo_documento: leer('tipo_documento'),
        asunto: leer('asunto'),
        numero_expediente: leer('numero_expediente'),
        remitente: leer('remitente'),
        fecha_deposito: leer('fecha_deposito'),
        leido_en_sunafil,
        datos_crudos,
      };
    });
  }

  private mapearCabeceras(cabeceras: string[]): Record<string, number> {
    const sinTilde = (t: string) => t.normalize('NFD').split('').filter((c) => { const n = c.charCodeAt(0); return n < 0x300 || n > 0x36f; }).join('').toLowerCase();
    const indicePorCampo: Record<string, number> = {};
    const usados = new Set<number>();

    for (const { campo, claves } of SunafilCasillaClient.MAPA_CABECERAS) {
      const i = cabeceras.findIndex((cab, idx) => !usados.has(idx) && claves.some((k) => sinTilde(cab).includes(k)));
      if (i >= 0) {
        indicePorCampo[campo as string] = i;
        usados.add(i);
      }
    }
    return indicePorCampo;
  }

  /**
   * Deja el HTML de la bandeja en disco para poder confirmar los selectores tras
   * la primera corrida real, sin tener que volver a golpear el portal (WAF). Es
   * best-effort: si falla escribir el archivo, NUNCA debe tumbar la sincronización.
   */
  private guardarDebug(ruc: string, html: string) {
    try {
      const carpeta = path.join(process.cwd(), 'storage-privado', 'debug-sunafil');
      fs.mkdirSync(carpeta, { recursive: true });
      fs.writeFileSync(path.join(carpeta, `bandeja-${ruc}.html`), html, 'utf8');
    } catch (e: any) {
      this.logger.warn(`No se pudo guardar el HTML de depuración de la casilla SUNAFIL: ${e?.message}`);
    }
  }
}

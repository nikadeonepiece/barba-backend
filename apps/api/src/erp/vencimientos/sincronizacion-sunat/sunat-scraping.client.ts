import { Injectable, Logger } from '@nestjs/common';
import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface ResultadoScrapingDeclaracion {
  declarado: boolean;
  fechaDeclaracion: string | null;
  rutaConstanciaDescargada: string | null;
  importePagado: number | null;
}

/**
 * FASE 2 — automatización de "Mis declaraciones y pagos" (PDT 621 / PLAME)
 * mediante navegador automatizado, porque no se encontró una API oficial
 * documentada y verificada para esto (ver ESTADO_AVANCE.md — hay indicio de
 * que sí existe una API para el 621 ("FV0621"), pendiente de confirmar; si se
 * confirma, este archivo completo se vuelve innecesario).
 *
 * ✅ LOGIN VERIFICADO EN VIVO contra sunat.gob.pe (con una Clave SOL real de
 * una empresa del estudio) — el flujo real es MULTI-VENTANA + IFRAME, no una
 * página plana como se supuso originalmente:
 *   1. `page.goto(LOGIN_URL)` — sol.html es un MENÚ público, no el login.
 *   2. El link "Mis Declaraciones y Pagos" no es una URL, dispara
 *      `javascript:declaraSimplificadaNueva()` y abre una VENTANA NUEVA
 *      (`context.waitForEvent('page')`, no `page.goto`).
 *   3. En esa ventana nueva, el botón `#btnPorRuc` (vs `#btnPorDni`) está en
 *      la página padre — hay que hacer click ahí antes de llenar el form.
 *   4. El formulario real (`#txtRuc`, `#txtUsuario`, `#txtContrasena`) vive
 *      DENTRO de un IFRAME servido por `api-seguridad.sunat.gob.pe` (flujo
 *      OAuth2) — hay que ubicar ese frame (`page.frames().find(...)`) y usar
 *      `frame.fill(...)`, `page.fill()` en la página padre no llega ahí.
 *   5. El botón de submit (`#btnAceptar`, texto "Iniciar sesión") SÍ está en
 *      la página padre, no en el iframe — se hace click ahí después de
 *      llenar el iframe.
 *   6. Tras el submit y la redirección OAuth2, la página aterriza logueada en
 *      `MenuInternetPlataforma.htm` mostrando "Bienvenido, <RAZÓN SOCIAL>".
 *
 * ✅ PANTALLA DE CONSULTA verificada en vivo (misma empresa de prueba). El menú
 * real es un árbol de 3 niveles que hay que expandir con clicks sucesivos:
 *   `Consultas` → `Consultas de Presentación y Pago` → `Consulta de
 *   Declaraciones y Pagos`. Esa pantalla vive en OTRO iframe, servido por
 *   `e-plataformaunica.sunat.gob.pe` (`consultaDeclaracionInternetprincipal`).
 *   Ahí dentro: `#criterios` (G=General/E=Específico), `#numFormulario` con
 *   los valores reales `0621` = IGV-Renta y **`0601` = Planilla Electrónica**
 *   (justo lo que necesita `tipoObligacion === 'PLANILLA'`), y el rango de
 *   fechas `#fechaIniPreConsultaDecla` / `input[name="idFecFin"]`.
 *
 * ✅ BOTÓN DE BÚSQUEDA correcto para el modo "General" (criterios=G):
 * `button[ng-click="buscarConstancia()"]`, sin id propio. `#buscar-resultado2`
 * (lo que se supuso primero) es un botón DISTINTO y oculto, ligado al modo
 * "Específico" (`buscarConstanciaEspecifica()`) — usarlo con criterios=G no
 * hace nada porque no está visible.
 *
 * ✅ REGLA DE NEGOCIO DE SUNAT verificada en vivo: el rango entre fecha inicio
 * y fecha fin **no puede exceder 6 meses** (ni siquiera exactamente 6 meses —
 * lo rechaza igual, hay que ir un día por debajo) — si se excede, SUNAT
 * muestra un modal de error y la búsqueda ni se ejecuta. Para consultar un
 * solo periodo mensual esto nunca es un problema (un mes cabe de sobra), pero
 * si en el futuro se agrega una consulta por rango de varios periodos hay que
 * partirla en tandas de <6 meses.
 *
 * ⚠️ PENDIENTE — la empresa de prueba usada (real, con Clave SOL real) no
 * tenía ninguna declaración presentada registrada en SUNAT en los rangos
 * probados, así que la ESTRUCTURA REAL de una fila de resultado CON DATOS
 * (`FILA_RESULTADO`/`CELDA_FECHA_PRESENTACION`/`LINK_DESCARGAR_CONSTANCIA` de
 * abajo) sigue siendo un supuesto sin confirmar. No seguir probando esto con
 * automatización sin supervisión — tras ~8 sesiones de prueba en vivo contra
 * sunat.gob.pe en poco tiempo, el WAF empezó a cortar conexiones (timeouts en
 * clicks que antes funcionaban); seguir insistiendo arriesga que le
 * restrinjan el acceso a la cuenta real de un cliente. Retomar esto con calma
 * (espaciado en el tiempo) y con un RUC que el estudio confirme que SÍ tiene
 * algo declarado en el periodo consultado.
 *
 * ⚠️ REVERTIDO (15/08/2026) — se había cambiado toda esta navegación por la
 * ruta "Mis Trámites y Consultas → Mis declaraciones informativas → Consulto
 * mis declaraciones y pagos → Consulta general" (documentada en el manual
 * oficial de SUNAT), persiguiendo la columna de importe pagado. Esa ruta
 * resultó mucho más frágil en la práctica: requería sortear un modal de
 * "Valida tus datos de contacto" que aparece de forma intermitente en
 * distintas variantes, un acordeón de menú de 4 niveles con nodos duplicados
 * ocultos, y el formulario de esa pantalla ("Consulta general") nunca llegó a
 * confirmarse selector por selector — cada arreglo destapaba un problema
 * nuevo, y en el camino se rompió la detección de "declarado" que SÍ
 * funcionaba de forma rápida y confiable con la navegación original de
 * arriba. Se revirtió por completo a esa navegación original — el único
 * agregado nuevo es la lectura de `CELDA_IMPORTE_PAGADO` (columna 8, mismo
 * supuesto sin confirmar que el resto de esta tabla) envuelta para que
 * cualquier fallo ahí NUNCA tumbe la detección de "declarado", que es lo que
 * ya funcionaba. Si se retoma la idea de "Consulta general" más adelante,
 * hacerlo en un archivo/método aparte, sin tocar esta ruta que funciona.
 */
@Injectable()
export class SunatScrapingClient {
  private readonly logger = new Logger(SunatScrapingClient.name);

  // --- Selectores del LOGIN: verificados en vivo ---
  private static readonly SELECTORES = {
    LOGIN_URL: 'https://www.sunat.gob.pe/sol.html',
    LINK_DECLARA_SIMPLIFICADA: 'a[href*="declaraSimplificadaNueva"]',
    BOTON_POR_RUC: '#btnPorRuc',
    IFRAME_URL_CONTIENE: 'api-seguridad.sunat.gob.pe',
    INPUT_RUC: '#txtRuc',
    INPUT_USUARIO: '#txtUsuario',
    INPUT_CLAVE: '#txtContrasena',
    BOTON_INGRESAR: '#btnAceptar',
    // --- Navegación al menú de consulta: verificado en vivo ---
    MENU_CONSULTAS: 'text=Consultas',
    MENU_CONSULTAS_PRESENTACION_PAGO: 'text=Consultas de Presentación y Pago',
    MENU_CONSULTA_DECLARACIONES: 'text=Consulta de Declaraciones y Pagos',
    IFRAME_CONSULTA_URL_CONTIENE: 'consultaDeclaracionInternetprincipal',
    SELECT_CRITERIOS: '#criterios',
    SELECT_FORMULARIO: '#numFormulario', // valores reales: '0621' (IGV-Renta), '0601' (Planilla)
    // ✅ CONFIRMADO EN VIVO (10/08/2026, ver debug-sunat/*.html): el formulario tiene DOS
    // filtros de fecha independientes — "Rango de Fecha de presentación" (cuándo se
    // presentó físicamente) y "Rango de Periodo Tributario" (mes/año que se está
    // declarando, lo que realmente nos importa). Son selects de MES + AÑO, no inputs de
    // fecha. Usar el periodo tributario, NO la fecha de presentación (una empresa puede
    // presentar el periodo de un mes recién el mes siguiente, o más tarde).
    PERIODO_MES_INICIO: '#periodo_tributario_1', // <select>, valores '01'..'12'
    PERIODO_ANIO_INICIO: '#periodo_tributario_1 + select', // <select> AngularJS ng-options, sin id propio — seleccionar por label (texto del año), no por value (viene como "number:2026")
    PERIODO_MES_FIN: '#periodo_tributario_2',
    PERIODO_ANIO_FIN: '#periodo_tributario_2 + select',
    BOTON_BUSCAR: 'button[ng-click="buscarConstancia()"]', // modo General — NO usar #buscar-resultado2 (es del modo Específico, oculto)
    // --- Estructura de la tabla de resultados: ✅ CONFIRMADA EN VIVO (10/08/2026) ---
    // La tabla real es `<table class="table">` (sin clase "resultados", eso era un
    // supuesto sin confirmar y estaba mal) dentro de `<div ng-show="resultado">`. Sin
    // clases propias en las celdas — se referencian por posición de columna:
    // 1=ID, 2=Periodo, 3=NroFormulario, 4=Descripción, 5=NroOrden, 6=FechaPresentación,
    // 7=Banco, 8=ImportePagado.
    FILA_RESULTADO: 'div[ng-show="resultado"] table tbody tr',
    CELDA_FECHA_PRESENTACION: 'td:nth-child(6)',
    // ⚠️ SIN CONFIRMAR EN VIVO — mismo supuesto de columnas de arriba (8=ImportePagado).
    // Lectura best-effort: si falla o la columna no es esta, NUNCA debe tumbar la
    // detección de "declarado" (por eso todo el bloque que la lee está en un try/catch
    // separado, no en el mismo flujo que fechaTexto).
    CELDA_IMPORTE_PAGADO: 'td:nth-child(8)',
    // ⚠️ No existe un link de descarga directa de PDF — el botón real ("Ver Constancia")
    // abre un modal de Angular (`ng-click="mostrarConstancia(constancia)"`), no dispara
    // un evento de descarga de archivo. Descargar el PDF automáticamente queda pendiente
    // de investigar aparte (hay que reverse-engineerar qué hace ese modal); por ahora
    // `consultarDeclaracion` no intenta descargar nada, solo confirma declarado + fecha.
  };

  async consultarDeclaracion(
    ruc: string,
    solUsuario: string,
    solPassword: string,
    tipoObligacion: 'IGV_RENTA' | 'PLANILLA',
    periodoAnio: number,
    periodoMes: number,
  ): Promise<ResultadoScrapingDeclaracion> {
    let browser: Browser | null = null;
    // Se va reasignando a la página que está "en foco" en cada etapa para que el catch
    // pueda volcar EXACTAMENTE la pantalla donde murió. Sin esto, un timeout de click
    // solo dice qué selector faltó, no qué había en su lugar (y las pantallas de SUNAT
    // que rompen esto — modal de datos de contacto, error de login, corte del WAF —
    // se distinguen únicamente mirando el HTML).
    let paginaActiva: Page | null = null;
    let etapa = 'inicio';
    try {
      browser = await chromium.launch({ headless: true, timeout: 30_000 });
      // Verificado en vivo contra sunat.gob.pe: sin un User-Agent de navegador real,
      // el WAF de SUNAT responde "Request Rejected" y bloquea la carga antes de
      // llegar a cualquier selector — el contexto por defecto de Playwright headless
      // se detecta y se corta ahí. Con este UA + viewport + locale sí carga la página.
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'es-PE',
      });
      const page = await context.newPage();
      paginaActiva = page;
      const s = SunatScrapingClient.SELECTORES;

      etapa = 'menu-sol';
      await page.goto(s.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // "Mis Declaraciones y Pagos" no navega — abre una ventana nueva vía JS.
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 15_000 }),
        page.click(s.LINK_DECLARA_SIMPLIFICADA),
      ]);
      const login = popup;
      paginaActiva = login;
      etapa = 'login';
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
      await login.waitForTimeout(2000); // margen para redirecciones OAuth2 posteriores al login

      const page2 = login; // a partir de aquí sigue en la misma ventana ya logueada
      etapa = 'menu-interno';

      // Árbol de 3 niveles — cada click expande el siguiente nivel, no navega directo.
      // ⚠️ `force: true` NO salta la espera del selector: solo se salta los chequeos de
      // "actionability" (visible, estable, no tapado). Si el timeout revienta acá con
      // `waiting for locator('text=Consultas')`, el texto NO está en el DOM — subir el
      // timeout no cambia nada, la pantalla es otra (login fallido, modal de "Valida
      // tus datos de contacto", o corte del WAF). Por eso el catch vuelca el HTML.
      await page2.click(s.MENU_CONSULTAS, { force: true });
      await page2.waitForTimeout(800);
      await page2.click(s.MENU_CONSULTAS_PRESENTACION_PAGO, { force: true });
      await page2.waitForTimeout(800);
      await page2.click(s.MENU_CONSULTA_DECLARACIONES, { force: true });
      await page2.waitForTimeout(2000);

      etapa = 'consulta';
      const frameConsulta = page2.frames().find((f) => f.url().includes(s.IFRAME_CONSULTA_URL_CONTIENE));
      if (!frameConsulta) throw new Error('No se encontró el iframe de "Consulta de Declaraciones y Pagos" — el portal pudo haber cambiado');

      const formulario = tipoObligacion === 'IGV_RENTA' ? '0621' : '0601';
      await frameConsulta.selectOption(s.SELECT_CRITERIOS, 'G');
      await frameConsulta.selectOption(s.SELECT_FORMULARIO, formulario);

      // Se busca el MISMO mes/año en "Inicio" y "Fin" del Periodo Tributario — un
      // solo periodo puntual, no un rango. Los selects de mes usan value plano
      // ('01'..'12'); los de año son ng-options de AngularJS (value real viene como
      // "number:2026", no confiable) — se seleccionan por label (el texto del año).
      const mesStr = String(periodoMes).padStart(2, '0');
      const anioStr = String(periodoAnio);
      await frameConsulta.selectOption(s.PERIODO_MES_INICIO, mesStr);
      await frameConsulta.selectOption(s.PERIODO_ANIO_INICIO, { label: anioStr });
      await frameConsulta.selectOption(s.PERIODO_MES_FIN, mesStr);
      await frameConsulta.selectOption(s.PERIODO_ANIO_FIN, { label: anioStr });

      await frameConsulta.click(s.BOTON_BUSCAR);
      await page2.waitForTimeout(3000);
      await frameConsulta.waitForSelector(s.FILA_RESULTADO, { timeout: 15_000 }).catch(() => null);

      const fila = frameConsulta.locator(s.FILA_RESULTADO).first();
      const hayResultado = (await fila.count()) > 0;
      if (!hayResultado) {
        return { declarado: false, fechaDeclaracion: null, rutaConstanciaDescargada: null, importePagado: null };
      }

      const fechaTexto = await fila.locator(s.CELDA_FECHA_PRESENTACION).textContent().catch(() => null);
      // SUNAT muestra la fecha como dd/mm/yyyy (peruano) — `new Date("11/06/2026")` en JS
      // la interpreta como mm/dd/yyyy (americano) y invierte día/mes. Se normaliza a
      // yyyy-mm-dd (ISO, sin ambigüedad) antes de devolverla.
      let fechaIso: string | null = null;
      if (fechaTexto) {
        const [dd, mm, yyyy] = fechaTexto.trim().split('/');
        if (dd && mm && yyyy) fechaIso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
      }

      // Columna 8 de la tabla real de SUNAT — ✅ CONFIRMADO EN VIVO (15/08/2026, ver
      // fila-declarada-*.html en debug-sunat): es el importe pagado, con formato real
      // "S/ 0" / "S/ 1,728.00" (símbolo de moneda + espacio + miles con coma). Envuelto
      // en su propio try/catch: si esta columna no es la correcta o no existe, NUNCA debe
      // afectar declarado/fechaIso ya resueltos arriba — solo se pierde el dato de pago.
      let importePagado: number | null = null;
      try {
        const importeTexto = await fila.locator(s.CELDA_IMPORTE_PAGADO).textContent().catch(() => null);
        if (importeTexto) {
          // Quita todo lo que no sea dígito o punto decimal (símbolo "S/", espacios) y
          // luego las comas de miles — sin esto, `Number("S/ 1,728.00")` da NaN y un
          // pago real se reportaba como "sin pagar" por error de parseo, no por dato real.
          const limpio = importeTexto.trim().replace(/[^0-9.,]/g, '').replace(/,/g, '');
          const monto = Number(limpio);
          if (limpio && !Number.isNaN(monto) && monto > 0) importePagado = monto;
        }
      } catch (errorImporte: any) {
        this.logger.warn(`No se pudo leer el importe pagado para RUC ${ruc} (${tipoObligacion} ${periodoAnio}-${periodoMes}): ${errorImporte?.message}`);
      }

      // Diagnóstico PURAMENTE aditivo — corre DESPUÉS de que declarado+fecha ya están
      // resueltos, nunca puede afectar el resultado ni bloquear el flujo (todo envuelto
      // en su propio catch silencioso). Guarda el HTML real de la fila con datos para
      // confirmar si la columna 8 es de verdad el importe pagado, sin arriesgar nada de
      // lo que ya funciona.
      try {
        // ⚠️ Carpeta PRIVADA: estos volcados son el HTML/PNG de una sesión SUNAT ya logueada
        // de un cliente del estudio. En `uploads/` quedaban descargables sin login.
        const carpetaDebug = path.join(process.cwd(), 'storage-privado', 'debug-sunat');
        fs.mkdirSync(carpetaDebug, { recursive: true });
        const filaHtml = await fila.evaluate((el) => el.outerHTML).catch(() => null);
        if (filaHtml) {
          fs.writeFileSync(
            path.join(carpetaDebug, `fila-declarada-${ruc}-${tipoObligacion}-${periodoAnio}${String(periodoMes).padStart(2, '0')}.html`),
            filaHtml,
          );
        }
      } catch { /* diagnóstico opcional, nunca debe afectar el resultado */ }

      // ✅ CONFIRMADO EN VIVO (10/08/2026): descarga real de la constancia.
      // "Ver Constancia" (a[ng-click*="mostrarConstancia"]) abre un modal DENTRO del
      // mismo iframe (no popup, no descarga directa); adentro, el botón "Guardar"
      // (button[ng-click="exportarConstancia()"]) SÍ dispara un evento `download` real
      // con el PDF oficial de SUNAT. Se guarda en la misma carpeta que usa la subida
      // manual (`uploads/constancias`, ver constancias.controller.ts) para que quede
      // servida igual y `declaracion.constancia_archivo` funcione sin diferenciar
      // origen manual vs automático.
      let rutaConstancia: string | null = null;
      try {
        const linkVerConstancia = fila.locator('a[ng-click*="mostrarConstancia"]');
        if ((await linkVerConstancia.count()) > 0) {
          await linkVerConstancia.click();
          await page2.waitForTimeout(1500);

          const botonGuardar = frameConsulta.locator('button[ng-click="exportarConstancia()"]');
          if ((await botonGuardar.count()) > 0) {
            const esperarDescarga = page2.waitForEvent('download', { timeout: 10_000 }).catch(() => null);
            await botonGuardar.click();
            const descarga = await esperarDescarga;
            if (descarga) {
              const carpetaConstancias = path.join(process.cwd(), 'storage-privado', 'constancias');
              fs.mkdirSync(carpetaConstancias, { recursive: true });
              const nombreArchivo = `constancia-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
              await descarga.saveAs(path.join(carpetaConstancias, nombreArchivo));
              rutaConstancia = `/constancias/${nombreArchivo}`;
            }
          }
        }
      } catch (errorConstancia: any) {
        // No bloquear la verificación por esto — declarado+fecha es lo que alimenta
        // el semáforo; si falla la descarga de la constancia, se puede subir a mano.
        this.logger.warn(`No se pudo descargar la constancia automáticamente para RUC ${ruc} (${tipoObligacion} ${periodoAnio}-${periodoMes}): ${errorConstancia?.message}`);
      }

      return {
        declarado: true,
        fechaDeclaracion: fechaIso,
        rutaConstanciaDescargada: rutaConstancia,
        importePagado,
      };
    } catch (error: any) {
      const pista = await this.guardarDebug(ruc, etapa, paginaActiva);
      this.logger.error(`Scraping SUNAT falló para RUC ${ruc} (${tipoObligacion} ${periodoAnio}-${periodoMes}) en la etapa "${etapa}": ${error?.message}`);
      throw new Error(
        `No se pudo verificar en SUNAT (portal web) en la etapa "${etapa}": ${error?.message || 'error desconocido'}. ` +
        (pista ? `Pantalla en la que murió volcada en ${pista} (HTML + captura). ` : '') +
        `Si el portal cambió de diseño, revisar los selectores en sunat-scraping.client.ts.`,
      );
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  /**
   * Vuelca la pantalla donde murió el scraping (HTML + captura PNG) a
   * `storage-privado/debug-scraping-sunat/`, igual que hace `sunat-buzon.client.ts`.
   * Va en storage-privado y NO en uploads/ porque el HTML de una sesión SOL logueada
   * trae datos del contribuyente, y uploads/ se sirve público sin login (ver main.ts).
   * Nunca lanza: si el volcado falla, el error original es lo que tiene que llegar.
   */
  private async guardarDebug(ruc: string, etapa: string, page: Page | null): Promise<string | null> {
    if (!page || page.isClosed()) return null;
    try {
      const carpeta = path.join(process.cwd(), 'storage-privado', 'debug-scraping-sunat');
      fs.mkdirSync(carpeta, { recursive: true });
      const base = `${etapa}-${ruc}`;
      const html = await page.content().catch(() => '');
      if (html) fs.writeFileSync(path.join(carpeta, `${base}.html`), html, 'utf8');
      await page.screenshot({ path: path.join(carpeta, `${base}.png`), fullPage: true }).catch(() => {});
      return `storage-privado/debug-scraping-sunat/${base}.html`;
    } catch {
      return null;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { chromium, Browser, Page, Frame, Locator } from 'playwright';

export interface TrabajadorScrapeado {
  numero_documento: string;
  tipo_documento: string | null;
  nombre_completo: string;
  fecha_ingreso: string | null;
  /** Fecha que muestra la pantalla del padrón. En el T-Registro es la de NACIMIENTO,
   *  no la de ingreso — se guarda aparte para no confundirlas al importar. */
  fecha_detectada?: string | null;
  regimen_pensionario: string | null;
  cuspp: string | null;
  situacion: string | null;
  sueldo_basico: string | null;
  // Datos personales de la ficha. La tabla planilla_trabajador ya tiene columna
  // para cada uno, así que se traen de una vez y no hay que tipearlos a mano.
  fecha_nacimiento?: string | null;
  sexo?: 'M' | 'F' | null;
  estado_civil?: string | null;
  nacionalidad?: string | null;
  direccion?: string | null;
  telefono?: string | null;
  email?: string | null;
  crudo: string[];
}

export interface ResultadoScrapeTregistro {
  exito: boolean;
  trabajadores: TrabajadorScrapeado[];
  mensaje: string;
  /** Volcado de lo que se encontró en pantalla, para depurar sin re-loguearse. */
  diagnostico: string[];
}

/**
 * Extrae el padrón de trabajadores del T-Registro de SUNAT.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ESTADO AL 27/08/2026: LOGIN Y RUTA DEL MENÚ VERIFICADOS EN VIVO
 *  FICHA INDIVIDUAL (sueldo y datos personales): EN VERIFICACIÓN
 * ═══════════════════════════════════════════════════════════════════════════════
 * Verificado contra sunat.gob.pe: el login, la cadena de redirects y los 5 niveles
 * de menú hasta la tabla del padrón. Lo que sigue sin confirmar son las etiquetas
 * DENTRO de la ficha de cada trabajador (pestaña "Trabajador"), por eso la primera
 * corrida vuelca esa pantalla al diagnóstico en vez de adivinar.
 *
 * LO QUE COSTÓ LLEGAR ACÁ, para no repetirlo:
 *   - sol.html tiene varias puertas y cada una deja la sesión en una APLICACIÓN
 *     distinta. Entrar por "Mis Declaraciones y Pagos" encierra la sesión en el
 *     módulo del 621, donde el T-Registro no existe. Va por "Mis trámites y
 *     consultas". Ver LINK_TRAMITES_CONSULTAS.
 *   - El login encadena 3 redirects y los 2 primeros son páginas de tránsito sin
 *     menú. Hay que esperar a LLEGAR al destino, no a "salir" de una de ellas.
 *     Ver `esperarMenu`.
 *   - Las acciones de cada fila son íconos SIN texto: buscarlas por nombre
 *     accesible no sirve. Ver `abrirFicha`.
 *   - Nacionalidad, teléfono y correo son campos de formulario: `innerText` no ve
 *     su valor y salían vacíos sin error. Ver `textoDePantalla`.
 *
 * La guía `TREG` en Configuración → Guías SUNAT documenta el mismo recorrido en
 * lenguaje humano. Guía y selectores describen lo mismo: al cambiar uno, cambiar
 * el otro o quedan contando historias distintas.
 *
 * ⚠️ SOLO LECTURA. La ficha tiene botones "Grabar" y "Salir": el primero
 * modificaría el T-Registro real de un cliente del estudio y el segundo cerraría la
 * sesión. Ver NUNCA_CLICKEAR — el clic se bloquea y se anota en el diagnóstico.
 *
 * ⚠️ EL WAF DE SUNAT: tras ~8 sesiones seguidas en poco tiempo, empieza a cortar
 * conexiones (timeouts en clicks que antes funcionaban). Está documentado en
 * `vencimientos/sincronizacion-sunat/sunat-scraping.client.ts` y en
 * `scripts/procesar-lote-credenciales-sire.js`. Por eso este cliente:
 *   - se usa de a UNA empresa, nunca en barrido masivo;
 *   - devuelve un DIAGNÓSTICO de lo que vio en pantalla, para que ajustar un
 *     selector no cueste otra sesión de login;
 *   - no crea nada solo — entrega el padrón para que un humano lo confirme.
 *
 * Insistir con automatización a ciegas arriesga que SUNAT restrinja el acceso a la
 * cuenta real de un cliente del estudio. Eso es peor que cargar el padrón a mano.
 */
@Injectable()
export class SunatTregistroScrapingClient {
  private readonly logger = new Logger(SunatTregistroScrapingClient.name);

  private static readonly SELECTORES = {
    // ---- ENTRADA AL PORTAL ----
    LOGIN_URL: 'https://www.sunat.gob.pe/sol.html',

    // ⚠️ LA PUERTA IMPORTA: sol.html tiene varias, y cada una deja la sesión en una
    // aplicación DISTINTA del portal.
    //
    //   javascript:declaraSimplificadaNueva()  → cl-ti-itmenu2/MenuInternetPlataforma.htm?exe=55.1.1.1.1
    //       Es "Mis Declaraciones y Pagos". La sesión queda ENCERRADA en ese módulo:
    //       el menú lateral solo muestra su árbol y las opciones del T-Registro no
    //       existen en el DOM. Salir de ahí no se pudo (ver abajo). Esta es la que
    //       se usaba antes y por eso el scraper nunca llegaba al padrón.
    //
    //   javascript:tramiteConsulta()           → cl-ti-itmenucabina/MenuInternet.htm
    //       Es "Mis trámites y consultas": el menú COMPLETO de SOL. Acá sí vive
    //       Empresas → Mi RUC y Otros Registros → T-Registro. Es la que usamos.
    //
    // Y no se puede saltar de una a otra: ir por URL a cl-ti-itmenu/MenuInternet.htm
    // rebota al login de api-seguridad, porque cada app hace su propio handoff de
    // token por AutenticaMenuInternet.htm. Probado y fallado el 27/08/2026.
    // La solución no es escaparse del módulo equivocado: es no entrar en él.
    LINK_TRAMITES_CONSULTAS: 'a[href*="tramiteConsulta"]',

    // ---- LOGIN (verificado en vivo, idéntico al de declaraciones) ----
    BOTON_POR_RUC: '#btnPorRuc',
    IFRAME_LOGIN_CONTIENE: 'api-seguridad.sunat.gob.pe',
    INPUT_RUC: '#txtRuc',
    INPUT_USUARIO: '#txtUsuario',
    INPUT_CLAVE: '#txtContrasena',
    BOTON_INGRESAR: '#btnAceptar',

    // Host del login OAuth2. Si después de entrar la URL sigue acá, SUNAT nos mandó
    // a autenticar de nuevo: hay que detectarlo porque la página carga con HTTP 200
    // y sin este chequeo el scraper haría clics a ciegas sobre un formulario.
    HOST_LOGIN: 'api-seguridad.sunat.gob.pe',


    // Ruta del menú, con el texto EXACTO tal como aparece en pantalla.
    // El cuarto nivel sale truncado en la UI ("...Pers. en forma"), así que se busca
    // por prefijo y no por el texto completo.
    MENU_EMPRESAS: 'Empresas',
    MENU_MI_RUC: 'Mi RUC y Otros Registros',
    MENU_TREGISTRO: 'T-Registro',
    MENU_REGISTRO_TRABAJADORES: 'Registro de Trabaj.',
    MENU_REGISTRO_INDIVIDUAL: 'Registro individual',

    // La pantalla final se llama "Registro de Trabajadores, Pensionistas y Otros" y
    // trae la tabla ya listada, sin necesidad de buscar: columnas Categoría (TRA para
    // trabajador), Documento de Identidad, Apellidos y Nombres, Fecha.
    TITULO_PANTALLA: /Registro de Trabajadores/i,
    FILA_RESULTADO: 'tbody tr',

    // La app del T-Registro vive en SU PROPIO IFRAME. Distinguirlo del marco
    // principal (que es el armazón del menú SOL) no es un detalle: el armazón tiene
    // sus propios <tbody><tr> y miles de caracteres de árbol de opciones. Sin esta
    // distinción, el 27/08/2026 los volcados de "la ficha" salieron siendo el menú
    // entero, sin un solo dato del trabajador, y el corte de 2500 caracteres se
    // consumía antes de llegar al iframe donde estaba la ficha de verdad.
    APP_TREGISTRO: 'ol-ti-itrtpspresta',

    // Marcador de que un marco muestra EL PADRÓN y no otra pantalla: cada fila trae
    // el enlace que abre la ficha. Verificado en el HTML de la primera fila:
    //   <a href="javascript:irModificar('24629232','4194123','1','01','40966442',…)">
    ENLACE_FICHA: 'a[href*="irModificar"]',

    // El documento viene como "L.E / DNI - 18191432", no como número pelado: hay que
    // extraerlo, no compararlo.
    PATRON_DOCUMENTO: /(\d{6,12})\s*$/,
    // ---- FICHA INDIVIDUAL (donde vive el sueldo) ----
    // La ficha abre en "Datos de Identificación" + la sección Categoría con pestañas:
    //   Resumen de Prestadores | Trabajador | Pensionista | Personal en formación
    // Lo laboral (remuneración, fecha de ingreso, régimen pensionario) está en la
    // pestaña "Trabajador". El resumen no trae ningún monto.
    PESTANA_TRABAJADOR: 'Trabajador',

    // ⚠️ "Retornar" PRIMERO y "Salir" JAMÁS: "Salir" cierra la sesión de SUNAT entera
    // y obliga a volver a loguearse (y el WAF cuenta cada login). La ficha tiene los
    // botones "Grabar" y "Retornar" — verificado en pantalla el 27/08/2026.
    ACCIONES_VOLVER: ['Retornar', 'Regresar', 'Volver', 'Cancelar'],

    // Nunca clickear nada que coincida con esto: modificaría el T-Registro del
    // cliente o cerraría la sesión. Solo leemos, no tocamos.
    NUNCA_CLICKEAR: /grabar|guardar|eliminar|dar de baja|salir|cerrar sesi|desactivar|anular/i,

    ACCIONES_FICHA: ['Editar', 'Modificar', 'Detalle', 'Ver', 'Consultar'],
    ETIQUETAS_REMUNERACION: [
      'Remuneración básica', 'Remuneracion basica', 'Remuneración', 'Remuneracion',
      'Sueldo básico', 'Sueldo basico', 'Sueldo', 'Ingreso mensual',
    ],
    // Importes peruanos: 1,500.00 / 1500.00 / 930.00
    PATRON_MONTO: /(\d{1,3}(?:[,]\d{3})*(?:\.\d{2})|\d+\.\d{2})/,
  };

  /**
   * @param headless `false` durante la verificación supervisada, para ver qué pasa.
   *                 En uso normal va `true`.
   */
  async extraerPadron(
    ruc: string,
    solUsuario: string,
    solPassword: string,
    headless = true,
  ): Promise<ResultadoScrapeTregistro> {
    const s = SunatTregistroScrapingClient.SELECTORES;
    const diagnostico: string[] = [];
    let browser: Browser | null = null;

    try {
      browser = await chromium.launch({ headless, timeout: 30_000 });
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'es-PE',
        acceptDownloads: true,
      });

      // Se graba TODO el tráfico con SUNAT desde el primer instante. Cada login gasta
      // uno de los ~8 que tolera el WAF, así que un intento tiene que dejar evidencia
      // completa y no una línea de diagnóstico. Sin esto se necesitaron cuatro
      // intentos para ver un mensaje de error que estaba en pantalla desde el primero.
      const traza: string[] = [];
      context.on('response', (r: any) => {
        const url = r.url();
        if (!/sunat\.gob\.pe/i.test(url)) return;
        const estado = r.status();
        if (estado >= 400 || /oauth2|Autentica|MenuInternet/i.test(url)) {
          traza.push(`HTTP ${estado} ${r.request().method()} ${this.urlCorta(url)}`);
        }
      });

      const page = await context.newPage();
      let sesion: Page;
      try {
        sesion = await this.login(context, page, ruc, solUsuario, solPassword, s, diagnostico);
      } catch (e) {
        // La traza dice si el fallo fue de SUNAT (5xx suyo) o nuestro (404/400 por un
        // selector mal puesto). Distinguir eso a ojo costó varias corridas.
        if (traza.length) diagnostico.push(`Tráfico con SUNAT: ${traza.slice(-12).join(' · ')}`);
        await this.guardarEvidencia(page, 'login', diagnostico);
        throw e;
      }
      if (traza.length) diagnostico.push(`Tráfico con SUNAT: ${traza.slice(-12).join(' · ')}`);

      // A partir de acá todo es supuesto. Cada paso registra en el diagnóstico qué
      // encontró, para que si falla se pueda corregir el selector sin volver a entrar.
      const frame = await this.navegarAlTregistro(sesion, s, diagnostico);

      if (!frame) {
        return {
          exito: false,
          trabajadores: [],
          mensaje:
            'Se entró a SUNAT correctamente, pero no se encontró la pantalla del T-Registro con los selectores actuales. ' +
            'Revisa el diagnóstico y corrige el bloque SELECTORES y la guía TREG.',
          diagnostico,
        };
      }

      const trabajadores = await this.leerTabla(frame, s, diagnostico);

      // El sueldo no está en el listado: hay que abrir la ficha de cada uno.
      if (trabajadores.length) await this.leerSueldos(sesion, s, trabajadores, diagnostico);

      return {
        exito: trabajadores.length > 0,
        trabajadores,
        mensaje: trabajadores.length
          ? `Se leyeron ${trabajadores.length} trabajador(es) del T-Registro`
          : 'Se llegó a la pantalla del T-Registro pero no se pudo leer ninguna fila. Revisa el diagnóstico.',
        diagnostico,
      };
    } catch (e: any) {
      diagnostico.push(`EXCEPCIÓN: ${e?.message ?? e}`);
      return {
        exito: false,
        trabajadores: [],
        mensaje: `Falló la consulta al T-Registro: ${e?.message ?? 'error desconocido'}`,
        diagnostico,
      };
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  /**
   * Pasos 1-4 de la guía: sol.html → "Mis trámites y consultas" → login por RUC.
   *
   * El login de SUNAT es OAuth2 y termina en un REDIRECT ENCADENADO:
   *
   *   api-seguridad.sunat.gob.pe/?code=<JWT>   ← acá ya estás autenticado
   *        ↓ (redirect automático, tarda unos segundos)
   *   e-menu.sunat.gob.pe/cl-ti-itmenucabina/MenuInternet.htm   ← el menú
   *
   * Por eso no alcanza con esperar un tiempo fijo: hay que esperar a que la URL SALGA
   * de api-seguridad. Con una espera de 2s la página quedaba en blanco a mitad del
   * salto y el scraper leía cero elementos (27/08/2026).
   */
  private async login(
    context: any, page: Page, ruc: string, usuario: string, clave: string,
    s: typeof SunatTregistroScrapingClient.SELECTORES, diagnostico: string[],
  ): Promise<Page> {
    await page.goto(s.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    diagnostico.push('OK — se abrió sol.html');

    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      page.click(s.LINK_TRAMITES_CONSULTAS),
    ]);
    await popup.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    diagnostico.push('OK — se abrió la ventana de login');

    // Se espera a que el formulario EXISTA, en vez de agarrar el iframe apenas carga
    // la ventana. La ventana sigue redirigiendo (cabina → login) durante un rato: si
    // se toma un iframe de un paso intermedio, se rellena y se envía contra un `state`
    // que SUNAT ya reemplazó, y el portal responde
    //   "Los parámetros de configuración de autenticación no coinciden por los
    //    generados por el sistema. Cierre la ventana y vuelva a ingresar."
    // Ese error apareció el 27/08/2026 y mandaba a buscar el problema en el menú,
    // cuando en realidad el login se estaba enviando contra una pantalla vencida.
    const frameLogin = await this.esperarFrameLogin(popup, s, diagnostico);

    // La pestaña RUC/DNI también vive dentro del iframe.
    await frameLogin.click(s.BOTON_POR_RUC).catch(() => {});

    await frameLogin.fill(s.INPUT_RUC, ruc);
    await frameLogin.fill(s.INPUT_USUARIO, usuario);
    await frameLogin.fill(s.INPUT_CLAVE, clave);

    // ⚠️ EL SUBMIT VA DENTRO DEL IFRAME, no en la página padre.
    //
    // Antes se rellenaba en el iframe y se hacía clic en `popup` (el documento de
    // afuera). Enviar un formulario desde un documento distinto del que lo contiene
    // es lo que hacía responder a SUNAT:
    //   "Los parámetros de configuración de autenticación no coinciden por los
    //    generados por el sistema. Cierre la ventana y vuelva a ingresar."
    // Verificado en pantalla el 27/08/2026: el formulario completo —RUC, Usuario,
    // Contraseña y el botón "Iniciar sesión"— está dentro del iframe de
    // api-seguridad.sunat.gob.pe.
    const [respuesta] = await Promise.all([
      popup.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
      this.enviarLogin(frameLogin, popup, s),
    ]);

    // Un 5xx acá es de SUNAT, no nuestro, y conviene decirlo con todas las letras:
    // el 27/08/2026 su /oauth2/authen devolvió "HTTP ERROR 500 · Request failed" y sin
    // este chequeo el scraper lo reportaba como si fuera un selector mal puesto,
    // mandando a corregir código que estaba bien.
    const estado = respuesta?.status() ?? 0;
    if (estado >= 500) {
      diagnostico.push(
        `FALLA — SUNAT respondió HTTP ${estado} en su propio endpoint de autenticación ` +
        `(${this.urlCorta(popup.url())}). Es un error del portal, no de este cliente. ` +
        'Suele pasar tras varios logins seguidos: esperar un rato antes de reintentar, ' +
        'porque insistir acerca el bloqueo del WAF sobre la cuenta del cliente.',
      );
      await this.volcarTextoDePagina(popup, diagnostico);
      throw new Error(
        `SUNAT devolvió HTTP ${estado} al autenticar. Es un problema del portal de SUNAT: ` +
        'espera unos minutos y vuelve a intentar.',
      );
    }

    await this.esperarMenu(popup, s, diagnostico);
    diagnostico.push(`OK — sesión iniciada. URL actual: ${this.urlCorta(popup.url())}`);
    return popup;
  }

  /**
   * Guarda captura de pantalla + HTML de la página en el momento del fallo.
   *
   * Cada login cuenta contra el WAF de SUNAT, así que un intento fallido tiene que
   * dejar todo lo necesario para diagnosticar sin volver a entrar. Los archivos van a
   * `logs/tregistro/` con la hora en el nombre.
   */
  private async guardarEvidencia(page: Page, etapa: string, diagnostico: string[]): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const carpeta = path.join(process.cwd(), 'logs', 'tregistro');
      await fs.mkdir(carpeta, { recursive: true });

      const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const base = path.join(carpeta, `${sello}-${etapa}`);

      await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
      await fs.writeFile(`${base}.html`, await page.content().catch(() => ''), 'utf8');

      diagnostico.push(`Evidencia guardada en logs/tregistro/${sello}-${etapa}.png y .html`);
    } catch (e: any) {
      diagnostico.push(`No se pudo guardar la evidencia: ${e?.message ?? e}`);
    }
  }

  /**
   * Envía el formulario de login desde DENTRO del iframe.
   *
   * Tres intentos, del más fiel al comportamiento humano hacia abajo:
   *   1. El botón por su id.
   *   2. El botón por su texto ("Iniciar sesión"), por si cambian el id.
   *   3. Enter en el campo de contraseña, que es lo que hace cualquiera.
   *
   * El clic en la página padre quedó descartado a propósito: enviar el formulario
   * desde otro documento es lo que rompía el `state` del OAuth.
   */
  private async enviarLogin(
    frameLogin: Frame, popup: Page, s: typeof SunatTregistroScrapingClient.SELECTORES,
  ): Promise<void> {
    if (await frameLogin.locator(s.BOTON_INGRESAR).count().catch(() => 0)) {
      await frameLogin.click(s.BOTON_INGRESAR);
      return;
    }

    const porTexto = frameLogin.getByRole('button', { name: /iniciar sesi/i }).first();
    if (await porTexto.count().catch(() => 0)) {
      await porTexto.click();
      return;
    }

    await frameLogin.locator(s.INPUT_CLAVE).press('Enter');
  }

  /**
   * Espera a que aparezca el iframe del login CON su formulario ya montado.
   *
   * No alcanza con `frames().find(...)`: la ventana sigue redirigiendo (cabina →
   * login) y el iframe puede existir antes que sus campos. Se exige ver el input del
   * RUC, que es la señal de que la pantalla es la definitiva y no una intermedia.
   */
  private async esperarFrameLogin(
    page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES, diagnostico: string[],
  ): Promise<Frame> {
    const limite = Date.now() + 30_000;

    while (Date.now() < limite) {
      for (const f of page.frames()) {
        if (!f.url().includes(s.IFRAME_LOGIN_CONTIENE)) continue;
        const listo = await f.locator(s.INPUT_RUC).count().catch(() => 0);
        if (listo) return f;
      }
      await page.waitForTimeout(500);
    }

    diagnostico.push(`No apareció el formulario de login en ${this.urlCorta(page.url())}`);
    await this.volcarTextoDePagina(page, diagnostico);
    throw new Error(
      'No se encontró el formulario de login de SUNAT. Si al entrar a mano también falla, ' +
      'es del portal: limpia las cookies de sunat.gob.pe y vuelve a intentar.',
    );
  }

  /**
   * Espera a que termine TODA la cadena de redirects del login, que tiene 3 saltos:
   *
   *   1. api-seguridad.sunat.gob.pe/?code=<JWT>            ← ya autenticado
   *   2. e-menu.../cl-ti-itmenu/AutenticaMenuInternet.htm  ← canjea el token
   *   3. e-menu.../cl-ti-itmenu/MenuInternet.htm           ← EL MENÚ (destino)
   *
   * Los pasos 1 y 2 son páginas de tránsito y no tienen menú alguno. Cortar en
   * cualquiera de los dos deja al scraper buscando "Empresas" donde no puede estar:
   * el paso 1 costó una corrida y el paso 2 la siguiente (27/08/2026). Por eso acá
   * no se espera "que salga de X" sino "que LLEGUE al menú", que es lo que importa.
   */
  private async esperarMenu(
    page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES, diagnostico: string[],
  ): Promise<void> {
    const esTransito = (href: string) =>
      href.includes(s.HOST_LOGIN) || /Autentica[A-Za-z]*\.htm/i.test(href);

    await page
      .waitForURL((url) => !esTransito(url.href), { timeout: 60_000 })
      .catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);

    if (!esTransito(page.url())) return;

    // ⚠️ ACÁ NO SE FUERZA NINGUNA URL, A PROPÓSITO.
    //
    // El intento anterior armaba el destino leyendo la ruta del `state=` y le pegaba
    // "?pestana=*&agrupacion=*". SUNAT lo rechazó con:
    //   "Los parámetros de configuración de autenticación no coinciden por los
    //    generados por el sistema. Cierre la ventana y vuelva a ingresar."
    // Y con razón: dentro del `state` la ruta viene seguida de un hash que el sistema
    // genera y valida (".../MenuInternet.htm&b64d26a8b5af0919..."). Al descartarlo y
    // poner parámetros propios, la URL deja de ser la que SUNAT emitió.
    //
    // Con un portal ajeno que además tiene WAF, inventar URLs de autenticación no es
    // una alternativa: si el redirect no salió solo, se informa y se corta.
    diagnostico.push(
      `FALLA — el redirect del login no llegó al menú; quedó en ${this.urlCorta(page.url())}. ` +
      'Abajo está el texto de esa pantalla, que suele decir el motivo exacto.',
    );
    await this.volcarTextoDePagina(page, diagnostico);
  }

  /**
   * Vuelca el texto visible de la página.
   *
   * `volcarOpcionesVisibles` solo lista elementos clickeables, y los mensajes de
   * error de SUNAT viven en párrafos sueltos: la pantalla del 27/08/2026 se veía como
   * "Volver | Política de privacidad | Aprende sobre SOL" y el motivo real —que el
   * portal SÍ estaba explicando— no aparecía por ningún lado.
   */
  private async volcarTextoDePagina(page: Page, diagnostico: string[]): Promise<void> {
    try {
      const texto = (await page.locator('body').innerText().catch(() => '') || '')
        .replace(/\s+/g, ' ')
        .trim();
      diagnostico.push(
        texto ? `Texto de la pantalla: ${texto.slice(0, 900)}` : 'La pantalla no tiene texto visible.',
      );
    } catch {
      diagnostico.push('No se pudo leer el texto de la pantalla.');
    }
  }

  /**
   * Acorta la URL para el diagnóstico.
   *
   * El callback de OAuth2 trae un JWT de ~1500 caracteres en el `code=`. Sin recortar,
   * un solo renglón del diagnóstico tapaba todo lo demás en pantalla — y además ese
   * token es una credencial de sesión, no conviene dejarlo escrito en la UI.
   */
  private urlCorta(url: string): string {
    try {
      const u = new URL(url);
      const params = [...u.searchParams.keys()];
      return params.length ? `${u.origin}${u.pathname}?${params.join('&')}=…` : `${u.origin}${u.pathname}`;
    } catch {
      return url.slice(0, 120);
    }
  }

  /**
   * Camina la ruta del T-Registro desde el menú de "Mis trámites y consultas".
   *
   *   Empresas → Mi RUC y Otros Registros → T-Registro
   *     → Registro de Trabaj., Pension., Pers. en forma... → Registro individual
   *
   * (Ruta confirmada en vivo por el usuario el 27/08/2026, con capturas de pantalla.)
   *
   * Ya NO hay paso previo de "salir del módulo": entrando por `tramiteConsulta()` la
   * sesión aterriza en el menú completo. Ver el comentario de LINK_TRAMITES_CONSULTAS
   * — dos intentos se fueron en pelear contra la puerta equivocada en vez de cambiarla.
   */
  private async navegarAlTregistro(
    page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES, diagnostico: string[],
  ): Promise<Frame | null> {
    diagnostico.push(`Aterrizaje del login: ${this.urlCorta(page.url())}`);

    // Ojo con el falso negativo: quedarse en api-seguridad NO siempre es fallo.
    // El callback de OAuth2 vive en ese mismo host y trae `?code=<JWT>` — ahí ya
    // estás autenticado, solo falta que termine el redirect. Confundir una cosa con
    // la otra hizo abortar una sesión buena el 27/08/2026.
    // Se cuenta como "no llegamos" tanto el login como la página que canjea el
    // token: ninguna de las dos tiene menú, y confundirlas con el destino fue lo
    // que hizo buscar "Empresas" en una pantalla de 3 links.
    if (page.url().includes(s.HOST_LOGIN) || /Autentica[A-Za-z]*.htm/i.test(page.url())) {
      const enCallback = /[?&]code=/.test(page.url());
      diagnostico.push(
        enCallback
          ? 'La sesión SÍ se autenticó (la URL trae el code de OAuth2) pero el redirect al ' +
            'menú no terminó a tiempo. Suele ser lentitud de SUNAT: reintentar.'
          : 'FALLA — SUNAT devolvió a la pantalla de login. Suele ser Clave SOL incorrecta ' +
            'para ese RUC, o una validación extra del portal.',
      );
      await this.volcarTextoDePagina(page, diagnostico);
      await this.volcarOpcionesVisibles(page, diagnostico);
      return null;
    }

    const ruta = [
      s.MENU_EMPRESAS,
      s.MENU_MI_RUC,
      s.MENU_TREGISTRO,
      s.MENU_REGISTRO_TRABAJADORES,
      s.MENU_REGISTRO_INDIVIDUAL,
    ];

    // El menú se despliega nivel por nivel: cada clic revela el siguiente.
    for (const etiqueta of ruta) {
      if (!(await this.clicEnMenu(page, etiqueta, diagnostico))) {
        diagnostico.push(
          `FALLA — no se encontró "${etiqueta}". Los niveles anteriores sí se abrieron ` +
          '(mirar los "OK — clic en" de arriba para saber hasta dónde se llegó). ' +
          'Si SUNAT cambió el texto, corregir el bloque SELECTORES y la guía TREG.',
        );
        await this.lupaSobre(page, etiqueta.split(' ')[0], diagnostico);
        await this.volcarOpcionesVisibles(page, diagnostico);
        return null;
      }
    }

    // La pantalla final puede abrirse en la misma página o dentro de un iframe:
    // el portal reparte sus módulos entre varios dominios.
    const marco = await this.ubicarPantallaPadron(page, s, diagnostico);
    if (!marco) {
      diagnostico.push('FALLA — se recorrió el menú entero pero no apareció la tabla del padrón.');
      await this.volcarOpcionesVisibles(page, diagnostico);
      return null;
    }
    return marco;
  }

  /**
   * Hace clic en una opción de menú por su texto.
   *
   * POR QUÉ TRES ESTRATEGIAS Y NO UNA:
   * la versión anterior escaneaba `a, span, li, div[role=treeitem]` y fallaba con
   * "Ir al inicio" — que en el portal es un <button>. El volcado de diagnóstico SÍ lo
   * listaba (ese sí miraba `button`), así que el síntoma era absurdo: "lo veo en la
   * lista pero no lo encuentro". Ahora se prueba por ROL (como lo ve una persona),
   * después por texto, y recién al final el escaneo manual.
   *
   * Se busca también dentro de los iframes: el portal reparte sus pantallas entre
   * varios dominios y el menú no siempre está en la página principal.
   */
  private async clicEnMenu(page: Page, etiqueta: string, diagnostico: string[]): Promise<boolean> {
    const marcos = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];

    for (const marco of marcos) {
      const donde = marco === page.mainFrame() ? '' : ` (iframe ${marco.url().slice(0, 60)})`;

      // 1) Por rol: es como lo ve una persona, y no depende de qué etiqueta HTML usó
      //    SUNAT. `name` hace match parcial e insensible a mayúsculas.
      for (const rol of ['link', 'button', 'menuitem', 'treeitem', 'tab'] as const) {
        const loc = marco.getByRole(rol, { name: etiqueta }).first();
        if (await this.intentarClic(page, loc, `${etiqueta} [rol=${rol}]${donde}`, diagnostico)) return true;
      }

      // 2) Por texto exacto: cubre los <span>/<td> sin rol accesible del árbol viejo.
      const porTexto = marco.getByText(etiqueta, { exact: true }).first();
      if (await this.intentarClic(page, porTexto, `${etiqueta} [texto exacto]${donde}`, diagnostico)) return true;

      // 3) Escaneo manual por prefijo: última red, para etiquetas que SUNAT trunca
      //    en pantalla ("Registro de Trabaj., Pension., Pers. en forma...").
      const candidatos = marco.locator('a, button, span, li, td, div[role="treeitem"]');
      const total = Math.min(await candidatos.count().catch(() => 0), 600);
      const buscado = etiqueta.toLowerCase();

      for (let i = 0; i < total; i++) {
        const nodo = candidatos.nth(i);
        const texto = ((await nodo.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (!texto.toLowerCase().startsWith(buscado)) continue;
        // Sin el tope, un contenedor que envuelve medio menú también "empieza con"
        // el texto y el clic caería en el lugar equivocado.
        if (texto.length > etiqueta.length + 45) continue;
        if (await this.intentarClic(page, nodo, `${texto} [escaneo]${donde}`, diagnostico)) return true;
      }
    }

    return false;
  }

  /** Un clic con espera; devuelve false en vez de reventar si el nodo no sirve. */
  private async intentarClic(
    page: Page, loc: Locator, descripcion: string, diagnostico: string[],
  ): Promise<boolean> {
    try {
      if (!(await loc.count())) return false;
      if (!(await loc.isVisible())) return false;

      // Este cliente SOLO LEE. Un clic en "Grabar" modificaría el T-Registro real
      // de un cliente del estudio, y uno en "Salir" cerraría la sesión (y cada
      // login nuevo acerca el bloqueo del WAF). La ficha tiene ambos botones.
      const texto = ((await loc.innerText().catch(() => '')) || '') +
        ' ' + ((await loc.getAttribute('title').catch(() => '')) || '') +
        ' ' + ((await loc.getAttribute('value').catch(() => '')) || '');
      if (SunatTregistroScrapingClient.SELECTORES.NUNCA_CLICKEAR.test(texto)) {
        diagnostico.push(`Se evitó clickear "${texto.trim().slice(0, 40)}" (${descripcion}): es una acción que modifica o cierra sesión.`);
        return false;
      }
      await loc.click({ timeout: 5_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      diagnostico.push(`OK — clic en "${descripcion}"`);
      return true;
    } catch {
      return false;
    }
  }

  /** Ubica la pantalla del padrón, esté en la página principal o en un iframe. */
  private async ubicarPantallaPadron(
    page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES, diagnostico: string[],
  ): Promise<Frame | null> {
    // Un margen extra: la pantalla del T-Registro tarda en montar su tabla.
    await page.waitForTimeout(2500);

    const marcos = this.marcosOrdenados(page, s);

    // 1) LO QUE DE VERDAD ES EL PADRÓN: un marco con enlaces a la ficha. Va primero
    //    porque "tbody tr" lo cumplen también el armazón del menú y la propia ficha
    //    ya abierta. Devolver ese marco equivocado hacía que después no se
    //    encontrara a nadie y el error saliera como "no se encontró cómo abrir la
    //    ficha de <el siguiente>", que manda a buscar el problema donde no está:
    //    el fallo real era una pantalla más atrás, al no haber vuelto al padrón.
    for (const frame of marcos) {
      const fichas = await frame.locator(s.ENLACE_FICHA).count().catch(() => 0);
      if (fichas > 0) {
        diagnostico.push(`OK — padrón encontrado en ${this.donde(page, frame)} (${fichas} fichas)`);
        return frame;
      }
    }

    // 2) Red de seguridad por si un usuario SOL sin permiso de edición no ve ese
    //    enlace: se acepta cualquier tabla, pero queda dicho que es una suposición.
    for (const frame of marcos) {
      const filas = await frame.locator(s.FILA_RESULTADO).count().catch(() => 0);
      if (filas > 0) {
        diagnostico.push(
          `Tabla encontrada en ${this.donde(page, frame)} (${filas} filas), pero sin enlaces ` +
          `"${s.ENLACE_FICHA}": puede no ser el padrón.`,
        );
        return frame;
      }
    }
    return null;
  }

  /**
   * Marcos a recorrer, con el del T-Registro ADELANTE y el armazón del menú al final.
   *
   * El orden es la corrección de fondo: recorrer `mainFrame` primero hacía que tanto
   * la búsqueda de elementos como la lectura de texto empezaran por el menú de SOL,
   * que siempre tiene algo que ofrecer, y nunca se llegaba al contenido real.
   */
  private marcosOrdenados(page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES): Frame[] {
    const otros = page.frames().filter((f) => f !== page.mainFrame());
    return [
      ...otros.filter((f) => f.url().includes(s.APP_TREGISTRO)),
      ...otros.filter((f) => !f.url().includes(s.APP_TREGISTRO)),
      page.mainFrame(),
    ];
  }

  /** El iframe donde corre la app del T-Registro (padrón y ficha), si está montado. */
  private marcoTregistro(page: Page): Frame | null {
    const app = SunatTregistroScrapingClient.SELECTORES.APP_TREGISTRO;
    return page.frames().find((f) => f.url().includes(app)) ?? null;
  }

  private donde(page: Page, frame: Frame): string {
    return frame === page.mainFrame() ? 'la página principal' : `el iframe ${this.urlCorta(frame.url())}`;
  }


  /**
   * Lee la tabla del padrón.
   *
   * Devuelve también `crudo` con la fila completa: si el orden de columnas no es el
   * supuesto, el usuario lo ve en la vista previa y se corrige el mapeo sin tener que
   * volver a entrar a SUNAT.
   */
  private async leerTabla(
    frame: Frame, s: typeof SunatTregistroScrapingClient.SELECTORES, diagnostico: string[],
  ): Promise<TrabajadorScrapeado[]> {
    const filas = frame.locator(s.FILA_RESULTADO);
    const total = await filas.count();
    diagnostico.push(
      `Se encontraron ${total} filas con "${s.FILA_RESULTADO}" (incluye tablas del menú y del ` +
      `armazón de la página; abajo se filtran las que tienen documento).`,
    );
    if (!total) return [];

    const salida: TrabajadorScrapeado[] = [];

    for (let i = 0; i < total; i++) {
      const celdas = filas.nth(i).locator('td');
      const n = await celdas.count();
      if (n < 2) continue;

      const crudo: string[] = [];
      for (let c = 0; c < n; c++) {
        crudo.push(((await celdas.nth(c).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim());
      }

      // El documento NO viene como número pelado: la columna dice "L.E / DNI - 18191432".
      // Confirmado en la pantalla real el 27/08/2026. Por eso se EXTRAE con un regex
      // en vez de comparar la celda entera — buscar /^\d{8,12}$/ no encontraba nada.
      let doc = '';
      let tipoDoc: string | null = null;

      for (const celda of crudo) {
        const m = celda.match(s.PATRON_DOCUMENTO);
        if (m && /DNI|L\.?E|C\.?E|PAS|CARN/i.test(celda)) {
          doc = m[1];
          tipoDoc = celda.split(/[-–]/)[0].replace(/\s+/g, ' ').trim();
          break;
        }
      }
      // Respaldo: alguna celda que sea solo el número, por si cambian el formato.
      if (!doc) doc = crudo.find((v) => /^\d{8,12}$/.test(v)) ?? '';
      if (!doc) continue;

      // El nombre viene como "GALVEZ DE LA CRUZ RUTH ELVIRA": mayúsculas, varias
      // palabras, sin dígitos. Se descarta la columna Categoría ("TRA"), que es corta.
      const nombre = crudo.find((v) =>
        v.length > 8 && /\s/.test(v) && !/\d/.test(v) && v === v.toUpperCase(),
      ) ?? '';

      const fecha = crudo.find((v) => /^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}$/.test(v)) ?? null;
      const monto = crudo.find((v) => /^\d{1,3}([,.]\d{3})*[,.]\d{2}$/.test(v)) ?? null;

      salida.push({
        numero_documento: doc,
        tipo_documento: tipoDoc,
        nombre_completo: nombre,
        // La columna de fecha de esta pantalla es la de NACIMIENTO, no la de ingreso
        // (en la captura: 03/02/…, 20/10/1958, 25/04/1984, 24/03/2004, 03/08/1974 —
        // años muy viejos para ser ingresos). Se deja en `crudo` y no se asume:
        // asignarla como fecha_ingreso daría trabajadores con 60 años de servicio.
        fecha_ingreso: null,
        fecha_detectada: fecha,
        // "TRA" = trabajador. Las demás categorías (pensionista, prestador, personal
        // en formación) no van al padrón de planilla.
        situacion: crudo.find((v) => /^(TRA|PEN|PRE|PER)$/i.test(v)) ?? null,
        regimen_pensionario: crudo.find((v) => /^(ONP|AFP|SNP|SPP)/i.test(v)) ?? null,
        cuspp: crudo.find((v) => /^\d{6}[A-Z]{5}\d$/i.test(v)) ?? null,
        sueldo_basico: monto,
        crudo,
      });
    }

    if (salida.length === 0 && total > 0) {
      diagnostico.push(`AVISO — había ${total} filas pero ninguna tenía un documento reconocible. Primera fila: ${JSON.stringify(await filas.nth(0).innerText().catch(() => ''))}`);
    }

    return salida;
  }

  /**
   * Abre la ficha de cada trabajador (el "editar" de su fila) y lee la remuneración.
   *
   * POR QUÉ HACE FALTA: el listado del padrón NO trae el sueldo — solo Categoría,
   * Documento, Apellidos y Nombres y Fecha. La remuneración básica sí está en el
   * T-Registro (Estructura 5, campo 16 del anexo de estructuras de SUNAT), pero
   * dentro de la ficha individual.
   *
   * VUELCA LA PRIMERA FICHA COMPLETA al diagnóstico. Las etiquetas exactas de esa
   * pantalla no están verificadas, así que la extracción se hace por texto ("...
   * Remuneración ... 1,500.00") y el volcado permite corregirla con evidencia en vez
   * de adivinar. Adivinar pantallas de SUNAT ya costó dos sesiones en este módulo.
   *
   * Si algo falla, se sigue igual: un sueldo que no se pudo leer queda en null y el
   * usuario lo completa a mano. Nunca aborta el padrón entero por esto.
   */
  private async leerSueldos(
    page: Page,
    s: typeof SunatTregistroScrapingClient.SELECTORES,
    trabajadores: TrabajadorScrapeado[],
    diagnostico: string[],
  ): Promise<void> {
    let leidos = 0;

    for (let i = 0; i < trabajadores.length; i++) {
      const t = trabajadores[i];
      try {
        // La tabla se vuelve a montar tras cada ida y vuelta: hay que relocalizarla.
        // El diagnóstico de la primera vuelta SÍ se guarda: era lo único que decía
        // en qué marco se creyó encontrar el padrón, y se estaba tirando a la basura.
        const marco = await this.ubicarPantallaPadron(page, s, i === 0 ? diagnostico : []);
        if (!marco) {
          diagnostico.push(
            i === 0
              ? 'Sueldos — no se ubicó la tabla del padrón antes de abrir la primera ficha. Se corta acá.'
              : `Sueldos — no se pudo volver al padrón después de la ficha ${i}. Se corta acá.`,
          );
          break;
        }

        if (!(await this.abrirFicha(marco, page, t, s, diagnostico, i === 0))) {
          // Se dice DÓNDE se buscó y QUÉ había en pantalla: cuando la vuelta al
          // padrón falla, el marco muestra otra cosa y el mensaje pelado señalaba a
          // la persona siguiente, que no tenía nada que ver con el fallo real.
          diagnostico.push(
            `Sueldos — no se encontró la fila de ${t.numero_documento} en ${this.donde(page, marco)}. ` +
            `Lo que hay en pantalla: ${(await this.textoDeMarco(marco)).slice(0, 400)}`,
          );
          if (i === 0) await this.volcarOpcionesVisibles(page, diagnostico);
          break;
        }

        // Se lee EL MARCO DE LA FICHA, no la página entera: el armazón del menú va
        // concatenado y su árbol de opciones se comía el corte del volcado.
        const marcoFicha = this.marcoTregistro(page) ?? marco;
        const texto = await this.textoDeMarco(marcoFicha);

        // Solo la PRIMERA: sirve para escribir los selectores definitivos con
        // evidencia. Volcar las N fichas llenaría el diagnóstico de ruido.
        if (i === 0) {
          diagnostico.push(`Ficha completa del primer trabajador (para ajustar selectores): ${texto.slice(0, 2500)}`);
        }

        // Lo personal está en la primera pantalla de la ficha.
        this.extraerIdentificacion(texto, t);

        // Lo laboral (sueldo, ingreso, pensión) vive en la pestaña "Trabajador":
        // la ficha abre en "Resumen de Prestadores", que no trae ningún monto.
        if (await this.abrirPestanaTrabajador(page, s, i === 0 ? diagnostico : [])) {
          const textoLaboral = await this.textoDeMarco(this.marcoTregistro(page) ?? marcoFicha);
          if (i === 0) {
            diagnostico.push(`Pestaña Trabajador del primero (para ajustar selectores): ${textoLaboral.slice(0, 2000)}`);
          }
          const monto = this.buscarRemuneracion(textoLaboral, s);
          if (monto) { t.sueldo_basico = monto; leidos++; }

          const ingreso = this.valorTrasEtiqueta(textoLaboral, 'Fecha de Inicio', ['Fecha de Fin', 'Régimen', 'Regimen', 'Tipo'])
            ?? this.valorTrasEtiqueta(textoLaboral, 'Fecha de Ingreso', ['Fecha de Fin', 'Régimen', 'Regimen', 'Tipo']);
          if (ingreso && /^\d{1,2}\/\d{1,2}\/\d{4}/.test(ingreso)) t.fecha_ingreso = ingreso.slice(0, 10);

          // \b para que "AFP" no coincida dentro de otra palabra y termine marcando
          // como afiliado al SPP a alguien que en realidad está en la ONP.
          if (/\bAFP\b|Sistema Privado/i.test(textoLaboral)) t.regimen_pensionario = 'AFP';
          else if (/\bONP\b|Sistema Nacional/i.test(textoLaboral)) t.regimen_pensionario = 'ONP';
        } else if (i === 0) {
          diagnostico.push('No se encontró la pestaña "Trabajador" de la ficha — el sueldo no está en el resumen.');
        }

        await this.volverAlPadron(page, s);
      } catch (e: any) {
        diagnostico.push(`Sueldos — falló la ficha de ${t.numero_documento}: ${e?.message ?? e}`);
        await this.volverAlPadron(page, s).catch(() => {});
      }
    }

    diagnostico.push(`Sueldos leídos: ${leidos} de ${trabajadores.length}`);
  }

  /**
   * Abre la ficha de un trabajador desde su fila del padrón.
   *
   * LAS ACCIONES SON ÍCONOS SIN TEXTO. En el volcado del 27/08/2026 cada fila salió
   * como "TRA · L.E / DNI - 40966442 · MORI SAAVEDRA JORGE LUIS · 13/07/1981 ·
   * Masculino · Activo · ·" — esas dos celdas vacías del final son los botones.
   * Buscarlos por nombre accesible ("Editar") no sirve: no hay ningún texto que
   * coincidir. Por eso, si falla la búsqueda por etiqueta, se hace clic en el
   * elemento clickeable de la fila, empezando por el final.
   */
  private async abrirFicha(
    marco: Frame, page: Page, t: TrabajadorScrapeado,
    s: typeof SunatTregistroScrapingClient.SELECTORES,
    diagnostico: string[], volcarHtml: boolean,
  ): Promise<boolean> {
    // Se ubica la fila POR EL DOCUMENTO, no por índice: si SUNAT reordena o pagina,
    // el índice apuntaría a otra persona y le pegaríamos el sueldo equivocado.
    const fila = marco.locator(s.FILA_RESULTADO).filter({ hasText: t.numero_documento }).first();
    if (!(await fila.count().catch(() => 0))) return false;

    // Una sola vez: el HTML crudo de la fila es lo que permite escribir el selector
    // definitivo de la acción sin gastar otra sesión de login adivinando.
    if (volcarHtml) {
      const html = await fila.innerHTML().catch(() => '');
      diagnostico.push(`HTML de la primera fila (para ubicar el botón de la ficha): ${html.slice(0, 1800)}`);
    }

    // 1) Por etiqueta, para el caso fácil (si algún día ponen texto).
    for (const etiqueta of s.ACCIONES_FICHA) {
      for (const rol of ['link', 'button'] as const) {
        const b = fila.getByRole(rol, { name: etiqueta }).first();
        if (await this.intentarClic(page, b, `ficha ${t.numero_documento} [${etiqueta}]`, diagnostico)) return true;
      }
      // Los íconos suelen llevar el texto en title/alt aunque no se vea.
      const porAtributo = fila.locator(
        `[title*="${etiqueta}" i], [alt*="${etiqueta}" i], [aria-label*="${etiqueta}" i]`,
      ).first();
      if (await this.intentarClic(page, porAtributo, `ficha ${t.numero_documento} [attr=${etiqueta}]`, diagnostico)) return true;
    }

    // 2) Cualquier cosa clickeable de la fila, DE ATRÁS PARA ADELANTE: las acciones
    //    van al final de la tabla, y así no se cae primero en un link del nombre.
    const clickeables = fila.locator('a, button, img, input[type="image"], [onclick], i[class*="icon" i], span[class*="icon" i]');
    const n = await clickeables.count().catch(() => 0);
    for (let k = n - 1; k >= 0; k--) {
      if (await this.intentarClic(page, clickeables.nth(k), `ficha ${t.numero_documento} [clickeable #${k} de ${n}]`, diagnostico)) {
        return true;
      }
    }

    if (volcarHtml) {
      diagnostico.push(`No había ningún elemento clickeable en la fila (se probaron ${n}).`);
    }
    return false;
  }

  /**
   * Texto de la pantalla INCLUYENDO el valor de los campos de formulario.
   *
   * `innerText` a secas no alcanza: en la ficha del T-Registro, Nacionalidad, Teléfono
   * y Correo son <select>/<input>, y su valor NO está en el texto del documento. Con
   * la versión anterior esos tres campos salían siempre vacíos sin dar ningún error.
   */
  private async textoDePantalla(page: Page): Promise<string> {
    const partes: string[] = [];

    // El orden importa para la extraccion, no solo para el volcado: valorTrasEtiqueta
    // y buscarRemuneracion se quedan con la PRIMERA aparicion de cada etiqueta, asi
    // que con el menu adelante cualquier coincidencia suya le gana a la de la ficha.
    for (const f of this.marcosOrdenados(page, SunatTregistroScrapingClient.SELECTORES)) {
      const t = await this.textoDeMarco(f);
      if (t) partes.push(t);
    }

    return partes.join(' || ');
  }

  /**
   * Lo mismo pero de UN SOLO marco.
   *
   * Es lo que hay que usar para la ficha: el armazon del menu de SOL aporta miles de
   * caracteres de arbol de opciones que no son datos de nadie, y al ir concatenado
   * delante se comia entero el corte de los volcados de diagnostico — por eso el
   * 27/08/2026 la "ficha completa del primer trabajador" era el menu y nada mas.
   */
  private async textoDeMarco(f: Frame): Promise<string> {
    const t = await f.evaluate(() => {
      const trozos: string[] = [];
      const recorrer = (n: Node) => {
        if (n.nodeType === 3) {
          const s = (n.textContent || '').trim();
          if (s) trozos.push(s);
          return;
        }
        if (n.nodeType !== 1) return;
        const el = n as HTMLElement;
        const tag = el.tagName;

        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const v = (el as HTMLInputElement).value;
          if (v) trozos.push(v);
          return;
        }
        if (tag === 'SELECT') {
          const sel = el as HTMLSelectElement;
          const v = sel.selectedOptions[0]?.text || '';
          if (v) trozos.push(v);
          return;
        }
        if (tag === 'SCRIPT' || tag === 'STYLE') return;

        el.childNodes.forEach(recorrer);
      };
      recorrer(document.body);
      return trozos.join(' ');
    }).catch(() => '');

    return t.replace(/\s+/g, ' ').trim();
  }

  /**
   * Saca el valor que sigue a una etiqueta.
   *
   * La ficha es un "Etiqueta: valor" corrido, así que se toma lo que viene después y
   * se corta en la etiqueta siguiente. El corte importa: sin él, "Sexo" se llevaría
   * también "Estado Civil: SOLTERO" pegado atrás.
   */
  private valorTrasEtiqueta(texto: string, etiqueta: string, cortes: string[]): string | null {
    const i = texto.toLowerCase().indexOf(etiqueta.toLowerCase());
    if (i < 0) return null;

    let resto = texto.slice(i + etiqueta.length).replace(/^[\s:]+/, '');
    for (const corte of cortes) {
      const j = resto.toLowerCase().indexOf(corte.toLowerCase());
      if (j > 0) resto = resto.slice(0, j);
    }
    const v = resto.trim().slice(0, 120).trim();
    return v || null;
  }

  /** Datos personales de la pestaña "Datos de Identificación". */
  private extraerIdentificacion(texto: string, t: TrabajadorScrapeado): void {
    const CORTES = [
      'País emisor', 'Pais emisor', 'Apellidos y Nombres', 'Sexo', 'Estado Civil',
      'Nacionalidad', 'Teléfono', 'Telefono', 'Primera dirección', 'Primera direccion',
      'Correo electrónico', 'Correo electronico', 'Segunda dirección', 'Segunda direccion',
      'Categoría', 'Categoria', 'Fecha de Nacimiento', 'Grabar', 'Retornar',
    ];

    const fechaNac = this.valorTrasEtiqueta(texto, 'Fecha de Nacimiento', CORTES);
    if (fechaNac && /^\d{1,2}\/\d{1,2}\/\d{4}/.test(fechaNac)) t.fecha_nacimiento = fechaNac.slice(0, 10);

    const sexo = this.valorTrasEtiqueta(texto, 'Sexo', CORTES);
    if (sexo) t.sexo = /^F/i.test(sexo) ? 'F' : /^M/i.test(sexo) ? 'M' : null;

    t.estado_civil = this.valorTrasEtiqueta(texto, 'Estado Civil', CORTES);
    t.nacionalidad = this.valorTrasEtiqueta(texto, 'Nacionalidad', CORTES);
    t.direccion = this.valorTrasEtiqueta(texto, 'Primera dirección', CORTES)
      ?? this.valorTrasEtiqueta(texto, 'Primera direccion', CORTES);

    const tel = this.valorTrasEtiqueta(texto, 'número )', CORTES)
      ?? this.valorTrasEtiqueta(texto, 'Teléfono', CORTES);
    if (tel) {
      const soloDigitos = (tel.match(/\d[\d\s-]{5,}/) || [''])[0].replace(/\s|-/g, '');
      t.telefono = soloDigitos || null;
    }

    const correo = (texto.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0];
    if (correo) t.email = correo;
  }

  /**
   * Saca el monto de remuneración del texto de la ficha.
   *
   * Busca la etiqueta y toma el primer importe que aparezca DESPUÉS, en una ventana
   * corta. Sin ese límite, una ficha sin sueldo devolvería cualquier otra cifra de
   * más abajo — un número plausible pero falso, que es peor que un null.
   */
  private buscarRemuneracion(texto: string, s: typeof SunatTregistroScrapingClient.SELECTORES): string | null {
    const bajo = texto.toLowerCase();

    for (const etiqueta of s.ETIQUETAS_REMUNERACION) {
      const aguja = etiqueta.toLowerCase();

      // TODAS las apariciones, no solo la primera: en la pestaña Trabajador la
      // palabra "Remuneración" aparece antes dentro de "Periodicidad de la
      // Remuneración: MENSUAL". Quedarse en esa devolvía el primer número que
      // hubiera cerca — un importe plausible, pero de otro campo.
      for (let i = bajo.indexOf(aguja); i >= 0; i = bajo.indexOf(aguja, i + aguja.length)) {
        if (/periodicidad|tipo de|forma de|modalidad/.test(bajo.slice(Math.max(0, i - 30), i))) continue;

        const m = texto.slice(i, i + 120).match(s.PATRON_MONTO);
        if (m) return m[1].replace(/,/g, '');
      }
    }
    return null;
  }

  /**
   * Abre la pestaña "Trabajador" de la sección Categoría, que es donde vive lo
   * laboral: remuneración, fecha de ingreso y régimen pensionario.
   *
   * La ficha abre en "Resumen de Prestadores", que solo lista qué categorías tiene la
   * persona — ahí no hay ningún sueldo. Leer el sueldo sin entrar a esta pestaña era
   * buscarlo donde no está (27/08/2026).
   */
  private async abrirPestanaTrabajador(
    page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES, diagnostico: string[],
  ): Promise<boolean> {
    // El marco va EN LA DESCRIPCIÓN del clic. Sin eso el diagnóstico decía
    // "OK — clic en pestaña Trabajador [tab]" sin manera de saber si se había
    // pulsado la pestaña de la ficha o cualquier otra cosa del menú de SOL.
    for (const marco of this.marcosOrdenados(page, s)) {
      const donde = ` en ${this.donde(page, marco)}`;

      for (const rol of ['tab', 'link', 'button'] as const) {
        const l = marco.getByRole(rol, { name: s.PESTANA_TRABAJADOR, exact: true }).first();
        if (await this.intentarClic(page, l, `pestaña ${s.PESTANA_TRABAJADOR} [${rol}]${donde}`, diagnostico)) return true;
      }
      const porTexto = marco.getByText(s.PESTANA_TRABAJADOR, { exact: true }).first();
      if (await this.intentarClic(page, porTexto, `pestaña ${s.PESTANA_TRABAJADOR} [texto]${donde}`, diagnostico)) return true;
    }
    return false;
  }

  /** Vuelve del detalle al listado. Primero el botón del portal, después el back. */
  private async volverAlPadron(page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES): Promise<void> {
    for (const etiqueta of s.ACCIONES_VOLVER) {
      if (await this.clicEnMenu(page, etiqueta, [])) break;
    }

    // VERIFICAR, NO SUPONER. La ficha se abre por POST DENTRO del iframe, así que el
    // historial de la página principal no se movió y `goBack` no devuelve al padrón.
    // Antes se daba por bueno el "Retornar" y la vuelta fallida se manifestaba una
    // iteración más tarde como "no se encontró cómo abrir la ficha de <el siguiente>",
    // que hace buscar el problema en la fila equivocada.
    if (await this.hayPadron(page, s)) return;

    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    if (await this.hayPadron(page, s)) return;

    // Último recurso: rehacer el último salto del menú. Cuesta unos segundos, pero
    // mucho menos que abortar el padrón entero y gastar otro login (el WAF cuenta).
    await this.clicEnMenu(page, s.MENU_REGISTRO_INDIVIDUAL, []);
    await page.waitForTimeout(1500);
  }

  /** ¿Hay un marco mostrando el padrón, con sus enlaces a las fichas? */
  private async hayPadron(page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES): Promise<boolean> {
    for (const f of this.marcosOrdenados(page, s)) {
      if (await f.locator(s.ENLACE_FICHA).count().catch(() => 0)) return true;
    }
    return false;
  }

/**
   * Muestra CÓMO está hecho en el HTML cada elemento cuyo texto contiene `aguja`.
   *
   * Existe por el fallo del 27/08/2026: el volcado listaba "Ir al inicio" pero el
   * clic no lo encontraba, porque el buscador miraba menos etiquetas HTML que el
   * volcador. Ver el tag y el rol de una vez evita ese ida y vuelta.
   */
  private async lupaSobre(page: Page, aguja: string, diagnostico: string[]) {
    try {
      const encontrados = await page.evaluate((texto) => {
        const salida: string[] = [];
        const nodos = Array.from(document.querySelectorAll('*'));
        for (const n of nodos) {
          const propio = Array.from(n.childNodes)
            .filter((c) => c.nodeType === 3)
            .map((c) => (c.textContent || '').trim())
            .join(' ');
          const etiquetaAria = n.getAttribute('aria-label') || n.getAttribute('title') || '';
          const candidato = (propio + ' ' + etiquetaAria).toLowerCase();
          if (!candidato.includes(texto.toLowerCase())) continue;
          const el = n as HTMLElement;
          salida.push(
            `<${n.tagName.toLowerCase()}` +
            (n.id ? ` id="${n.id}"` : '') +
            (n.getAttribute('role') ? ` role="${n.getAttribute('role')}"` : '') +
            (n.className && typeof n.className === 'string' ? ` class="${n.className.slice(0, 60)}"` : '') +
            (n.getAttribute('href') ? ` href="${n.getAttribute('href')!.slice(0, 80)}"` : '') +
            (n.getAttribute('onclick') ? ` onclick="${n.getAttribute('onclick')!.slice(0, 80)}"` : '') +
            `> visible=${!!(el.offsetParent || el.offsetWidth || el.offsetHeight)}`,
          );
          if (salida.length >= 8) break;
        }
        return salida;
      }, aguja);

      diagnostico.push(
        encontrados.length
          ? `Elementos que contienen "${aguja}": ${encontrados.join('  ||  ')}`
          : `No hay ningún elemento cuyo texto contenga "${aguja}"`,
      );
    } catch (e: any) {
      diagnostico.push(`No se pudo inspeccionar "${aguja}": ${e?.message ?? e}`);
    }
  }

  /**
   * Vuelca todo lo que hay en pantalla: es lo que permite corregir el menú sin gastar
   * otra sesión de login (y el WAF hace que cada sesión cuente).
   *
   * Incluye los iframes, no solo la página principal — el portal de SUNAT reparte sus
   * pantallas entre varios dominios, y una opción que "no aparece" muchas veces está
   * dentro de un iframe que no estábamos mirando.
   */
  private async volcarOpcionesVisibles(page: Page, diagnostico: string[]) {
    try {
      diagnostico.push(`URL actual: ${page.url()}`);

      const textos = await page.locator('a, button, span[role="treeitem"], li').allInnerTexts();
      const utiles = [...new Set(
        textos.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.length > 2 && t.length < 90),
      )];
      diagnostico.push(`Opciones en la página principal (${utiles.length}): ${utiles.slice(0, 60).join(' | ')}`);

      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const t = await frame.locator('a, button, span[role="treeitem"], li').allInnerTexts().catch(() => []);
        const u = [...new Set(t.map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length > 2 && x.length < 90))];
        if (u.length) {
          diagnostico.push(`Opciones en el iframe ${frame.url()} (${u.length}): ${u.slice(0, 40).join(' | ')}`);
        }
      }
    } catch {
      diagnostico.push('No se pudieron listar las opciones visibles');
    }
  }
}

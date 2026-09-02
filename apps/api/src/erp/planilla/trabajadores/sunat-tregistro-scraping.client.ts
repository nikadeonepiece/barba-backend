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
 *  ESTADO AL 01/09/2026: RECORRIDO COMPLETO VERIFICADO — 11 de 11 sueldos leídos
 *  en una corrida real contra el RUC 20530093019.
 * ═══════════════════════════════════════════════════════════════════════════════
 * Verificado contra sunat.gob.pe: el login, la cadena de redirects, los 5 niveles de
 * menú hasta la tabla del padrón y —con capturas de la ficha real— dónde vive el
 * sueldo: pestaña "Trabajador" → Datos laborales → "Monto de remuneración básica
 * inicial", que es un <input> con el importe (p. ej. 2000: SIN decimales).
 *
 * ⚠️ LO MÁS GRAVE QUE ENSEÑÓ ESA CAPTURA: la fila del padrón termina en DOS columnas
 * de acción — "Modificar" (el ícono que abre la ficha) y "Eliminar" (una X roja que
 * da de baja al trabajador en el T-Registro real del cliente). La versión anterior,
 * cuando no ubicaba el ícono por su etiqueta, clickeaba "cualquier cosa clickeable de
 * la fila, DE ATRÁS PARA ADELANTE": o sea que la primera que probaba era esa X. Ese
 * recorrido ya no existe. Ver `abrirFicha`.
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
 *     accesible no sirve. Lo que sí las distingue es el javascript: del href —
 *     irModificar() abre la ficha, y es lo único que se clickea. Ver `abrirFicha`.
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

    // Hermana de "Registro individual" en el mismo submenú. No se usa para leer el
    // padrón: es para el MODO EXPLORACIÓN, que va a ver si por acá se puede sacar el
    // sueldo de todos de una vez en lugar de abrir once fichas.
    MENU_CONSULTAS_REPORTES: 'Consultas y reportes',

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
    //
    // Es TAMBIÉN la única forma segura de ABRIR la ficha. Columnas de la tabla,
    // verificadas en pantalla el 01/09/2026:
    //   Categoría | Documento de Identidad | Apellidos y Nombres | Fec. Nac. |
    //   Sexo | Estado | Modificar | Eliminar
    // Las dos últimas son íconos sin texto y la ÚLTIMA borra. Por eso la ficha no se
    // abre nunca "por posición" en la fila: se clickea este href y nada más.
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
    //
    // Se compara contra el texto Y contra el href/onclick del elemento, porque los
    // íconos de la fila no tienen texto ninguno: el de borrar es una X roja y lo
    // único que lo delata es su javascript:. Mirando solo el texto, este filtro
    // dejaba pasar justo el clic que da de baja al trabajador.
    NUNCA_CLICKEAR: /grabar|guardar|eliminar|dar de baja|darDeBaja|salir|cerrar sesi|desactivar|anular/i,

    // La ficha llama al sueldo "Monto de remuneración básica inicial" — verificado en
    // pantalla el 01/09/2026. Va PRIMERO por ser la etiqueta exacta; las demás quedan
    // como red por si SUNAT la abrevia en otra empresa.
    ETIQUETAS_REMUNERACION: [
      'Monto de remuneración básica inicial', 'Monto de remuneracion basica inicial',
      'remuneración básica inicial', 'remuneracion basica inicial',
      'Remuneración básica', 'Remuneracion basica', 'Remuneración', 'Remuneracion',
      'Sueldo básico', 'Sueldo basico', 'Sueldo', 'Ingreso mensual',
    ],

    // Régimen pensionario y CUSPP NO están en "Datos laborales": viven en esta
    // sección, que la ficha muestra plegada. Se despliega DESPUÉS de leer el sueldo,
    // para que un fallo acá no cueste el dato que fuimos a buscar.
    SECCION_SEGURIDAD_SOCIAL: 'Datos de Seguridad Social',

    // Importes peruanos, CON O SIN decimales: 1,500.00 / 1500.00 / 930.50 / 2000.
    // Lo de "sin decimales" no es un extra: la ficha de MORI SAAVEDRA trae 2000
    // pelado y el patrón anterior exigía dos decimales — encontraba la etiqueta, no
    // encontraba número y devolvía null. El sueldo llegaba vacío sin un solo error.
    PATRON_MONTO: /(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/,
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
    explorarReportes = false,
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

      // MODO EXPLORACIÓN: va a mirar qué ofrece "Consultas y reportes" — ¿se puede
      // bajar el padrón CON la remuneración en un solo archivo, en vez de abrir una
      // ficha por trabajador? Va DESPUÉS de la lectura y no en lugar de ella: así un
      // mismo login contesta las dos preguntas. Con el WAF contando sesiones, gastar
      // una entera en cada una es un lujo.
      //
      // `sesion`, NO `page`: el login abre una VENTANA NUEVA y ahí vive el menú de
      // SOL. `page` se queda en sol.html, el portal público — escrito así, buscó
      // "Consultas y reportes" entre "Agricultura, ganadería y pesca" y
      // "Transparencia", y gastó una sesión para decir que no lo encontraba.
      if (explorarReportes) await this.mirarConsultasYReportes(sesion, s, diagnostico);

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

  /**
   * Un clic con espera; devuelve false en vez de reventar si el nodo no sirve.
   *
   * @param esperaMs pausa fija DESPUÉS del clic. Los 2 s del menú están medidos
   *   contra SUNAT y no se tocan, pero dentro de la ficha el resultado se verifica
   *   igual (que aparezca "Datos laborales", que vuelva el padrón), así que esperar
   *   lo mismo era dormir de más: cuatro clics por ficha × once fichas son casi 90
   *   segundos regalados, y con eso la petición se pasaba del techo de tiempo.
   */
  private async intentarClic(
    page: Page, loc: Locator, descripcion: string, diagnostico: string[], esperaMs = 2000,
  ): Promise<boolean> {
    try {
      if (!(await loc.count())) return false;
      if (!(await loc.isVisible())) {
        diagnostico.push(`"${descripcion}" existe pero no está visible.`);
        return false;
      }

      // Este cliente SOLO LEE. Un clic en "Grabar" modificaría el T-Registro real
      // de un cliente del estudio, y uno en "Salir" cerraría la sesión (y cada
      // login nuevo acerca el bloqueo del WAF). La ficha tiene ambos botones.
      const texto = ((await loc.innerText().catch(() => '')) || '') +
        ' ' + ((await loc.getAttribute('title').catch(() => '')) || '') +
        ' ' + ((await loc.getAttribute('value').catch(() => '')) || '') +
        // El ícono de borrar de la fila no tiene texto NI title: lo único que lo
        // identifica es su javascript:. Mirando solo el texto, este filtro lo daba
        // por inofensivo — y es el que da de baja al trabajador.
        ' ' + ((await loc.getAttribute('href').catch(() => '')) || '') +
        ' ' + ((await loc.getAttribute('onclick').catch(() => '')) || '');
      if (SunatTregistroScrapingClient.SELECTORES.NUNCA_CLICKEAR.test(texto)) {
        diagnostico.push(`Se evitó clickear "${texto.trim().slice(0, 40)}" (${descripcion}): es una acción que modifica o cierra sesión.`);
        return false;
      }
      await loc.click({ timeout: 5_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(esperaMs);
      diagnostico.push(`OK — clic en "${descripcion}"`);
      return true;
    } catch (e: any) {
      // EL ELEMENTO ESTABA Y AUN ASÍ NO SE PUDO CLICKEAR: eso hay que decirlo. El
      // 01/09/2026 el botón "Retornar" de la ficha no se pulsó y el `catch` mudo dejó
      // el diagnóstico sin una sola línea sobre el asunto — se veía igual que si el
      // botón no existiera, que es justo la confusión que hace perder una sesión.
      // Los candidatos que directamente no existen siguen sin ensuciar nada: esos
      // salen antes por `count()`.
      diagnostico.push(`No se pudo clickear "${descripcion}": ${String(e?.message ?? e).split(String.fromCharCode(10))[0].slice(0, 140)}`);
      return false;
    }
  }

  /**
   * MODO EXPLORACIÓN. Abre "Consultas y reportes" y vuelca lo que hay: el texto de
   * cada marco, las opciones clickeables y los controles del formulario.
   *
   * Por qué existe: leer el sueldo abriendo la ficha de cada trabajador funciona
   * (11/11 el 01/09/2026) pero es caro y frágil — una navegación por persona, con
   * sus tiempos de carga, dentro de la pantalla de EDICIÓN del registro real del
   * cliente. Si esta otra opción del menú permite bajar el padrón con la
   * remuneración incluida, todo eso sobra.
   *
   * No hace clic en nada que no sea la opción del menú: solo mira.
   */
  private async mirarConsultasYReportes(
    page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES, diagnostico: string[],
  ): Promise<void> {
    // HAY QUE REABRIR LA RAMA DEL MENÚ. Después de recorrer las once fichas, el árbol
    // de SOL vuelve a plegarse: la opción sigue en el DOM pero oculta, y el clic no
    // la agarra. El diagnóstico del 01/09/2026 lo dijo con todas las letras —
    // "Consultas y reportes [texto exacto]" existe pero no está visible— gracias a
    // que `intentarClic` ahora informa ese caso en vez de devolver false en silencio.
    // Se reabren los dos niveles de arriba, sin exigir que funcionen: si el árbol ya
    // estaba abierto, el clic no encuentra nada que hacer y no pasa nada.
    await this.clicEnMenu(page, s.MENU_TREGISTRO, diagnostico);
    await this.clicEnMenu(page, s.MENU_REGISTRO_TRABAJADORES, diagnostico);

    if (!(await this.clicEnMenu(page, s.MENU_CONSULTAS_REPORTES, diagnostico))) {
      diagnostico.push(`No se encontró "${s.MENU_CONSULTAS_REPORTES}" en el menú.`);
      await this.volcarOpcionesVisibles(page, diagnostico);
      return;
    }

    await page.waitForTimeout(4000);

    for (const marco of this.marcosOrdenados(page, s)) {
      const texto = await this.textoDeMarco(marco);
      if (texto.trim().length > 40) {
        diagnostico.push(`PANTALLA en ${this.donde(page, marco)}: ${texto.slice(0, 2500)}`);
      }
    }

    // Los controles importan tanto como el texto: un <select> de periodo o un botón
    // de "Generar/Descargar" es la diferencia entre un reporte servible y una
    // consulta en pantalla.
    for (const marco of this.marcosOrdenados(page, s)) {
      const controles = await marco.evaluate(() => Array.from(
        document.querySelectorAll('select, input, button, a[href]'),
      ).slice(0, 60).map((e) => {
        const el = e as HTMLElement;
        const t = el.tagName.toLowerCase();
        const attr = (n: string) => el.getAttribute(n) || '';
        if (t === 'select') {
          const s2 = el as unknown as HTMLSelectElement;
          const ops = Array.from(s2.options).slice(0, 6).map((o) => o.text).join('/');
          return `<select ${attr('name') || attr('id')}> [${ops}]`;
        }
        return `<${t} ${attr('type')} ${attr('name') || attr('id')}> "${(el.innerText || attr('value') || '').replace(/\s+/g, ' ').trim().slice(0, 45)}" ${attr('href').slice(0, 60)}`;
      })).catch(() => [] as string[]);
      if (controles.length) {
        diagnostico.push(`CONTROLES en ${this.donde(page, marco)}: ${controles.join(' · ').slice(0, 2200)}`);
      }
    }

    await this.volcarOpcionesVisibles(page, diagnostico);
  }

  /** Ubica la pantalla del padrón, esté en la página principal o en un iframe. */
  private async ubicarPantallaPadron(
    page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES, diagnostico: string[],
  ): Promise<Frame | null> {
    // Antes acá había una espera fija de 2,5 s "por si la tabla tarda en montar".
    // Se pagaba entera en CADA ficha, incluso cuando el padrón ya estaba en pantalla
    // —que es lo normal, porque volverAlPadron ya lo verificó antes de devolver—. Con
    // once trabajadores son casi 30 segundos dormidos al pedo. Ahora se sondea: sale
    // apenas aparece, y solo espera de verdad cuando hace falta.
    await this.esperarPadron(page, s, 8_000);

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

    // La URL del iframe del padrón, con su token. Se guarda la primera vez que se lo
    // encuentra porque es la forma más confiable de volver: no depende de acertarle a
    // ningún botón. Ver volverAlPadron.
    let urlPadron: string | null = null;

    for (let i = 0; i < trabajadores.length; i++) {
      const t = trabajadores[i];

      // UNA LÍNEA POR FICHA, SIEMPRE. Antes solo la primera dejaba rastro y las otras
      // pasaban en silencio: la corrida del 01/09/2026 trajo UN sueldo de once y el
      // diagnóstico no permitía saber si las otras diez fallaron al abrir la ficha, al
      // abrir la pestaña o al volver al padrón. Once líneas cortas no cuestan nada y
      // ahorran otra sesión a ciegas.
      const traza: string[] = [];
      const anotar = () =>
        diagnostico.push(`Ficha ${i + 1}/${trabajadores.length} (${t.numero_documento}): ${traza.join(' · ')}`);

      try {
        // La tabla se vuelve a montar tras cada ida y vuelta: hay que relocalizarla.
        const marco = await this.ubicarPantallaPadron(page, s, i === 0 ? diagnostico : []);
        if (!marco) {
          traza.push(i === 0
            ? 'NO se ubicó la tabla del padrón antes de la primera ficha — se corta acá'
            : 'NO se pudo volver al padrón — se corta acá');
          anotar();
          break;
        }
        if (!urlPadron) urlPadron = marco.url();

        if (!(await this.abrirFicha(marco, page, t, s, diagnostico, i === 0))) {
          // Se dice DÓNDE se buscó y QUÉ había en pantalla: cuando la vuelta al padrón
          // falla, el marco muestra otra cosa y el mensaje pelado señalaba a la persona
          // siguiente, que no tenía nada que ver con el fallo real.
          traza.push(`NO se encontró su fila en ${this.donde(page, marco)} — se corta acá`);
          traza.push(`en pantalla: ${(await this.textoDeMarco(marco)).slice(0, 300)}`);
          anotar();
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

        // Lo laboral (sueldo, ingreso) vive en la pestaña "Trabajador": la ficha abre
        // en "Resumen de Prestadores", que no trae ningún monto.
        if (await this.abrirPestanaTrabajador(page, s, marcoFicha, t.numero_documento, traza, i === 0 ? diagnostico : [])) {
          const textoLaboral = await this.textoDeMarco(this.marcoTregistro(page) ?? marcoFicha);
          if (i === 0) {
            diagnostico.push(`Pestaña Trabajador del primero (para ajustar selectores): ${textoLaboral.slice(0, 2000)}`);
          }

          // DEL CAMPO, no del texto: ver valorDeCampo. Un '' quiere decir que la
          // etiqueta está y el campo está vacío — eso es un sueldo que SUNAT no
          // tiene, y se deja en null en vez de buscarle un número cerca.
          const marcoAhora = this.marcoTregistro(page) ?? marcoFicha;
          const campo = await this.valorDeCampo(marcoAhora, s.ETIQUETAS_REMUNERACION);
          const delCampo = campo ? (campo.replace(/[^\d.,]/g, '').replace(/,/g, '') || null) : null;

          // Si el campo no dio un número usable se cae a la red de texto, que ahora
          // corta en el rótulo siguiente y ya no puede traerse el "1" de "Jornada
          // laboral". Antes esto no existía: un campo ilegible dejaba el sueldo en
          // null aunque el dato estuviera a la vista en la misma pantalla.
          const monto = (delCampo && Number(delCampo) > 0)
            ? delCampo
            : this.buscarRemuneracion(textoLaboral, s);
          const fuente = (delCampo && Number(delCampo) > 0) ? 'campo' : 'texto';

          if (monto && Number(monto) > 0) {
            t.sueldo_basico = monto;
            leidos++;
            traza.push(`sueldo ${monto} (${fuente})`);
          } else {
            traza.push(`SIN monto (campo leído: ${JSON.stringify(campo)})`);
          }

          // La fecha de ingreso es la "Fecha de Inicio" del Periodo laboral, pero se
          // busca desde "Periodo laboral" y NO desde "Fecha de Inicio": en esta
          // pantalla los rótulos de las tres columnas van todos juntos ANTES de los
          // campos, así que justo detrás de "Fecha de Inicio" no hay una fecha sino el
          // rótulo siguiente ("(dd/mm/aaaa) Fecha de Fin ...").
          // La fecha de ingreso, del mismo modo y por la misma razón. El texto
          // corrido queda de red por si SUNAT cambia el armado de la fila.
          const campoIngreso = await this.valorDeCampo(marcoAhora, ['Periodo laboral']);
          const ingreso = (campoIngreso && /^\d{2}\/\d{2}\/\d{4}$/.test(campoIngreso.trim()))
            ? campoIngreso.trim()
            : (textoLaboral.match(/Periodo laboral:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? null);

          if (ingreso) {
            t.fecha_ingreso = ingreso;
            traza.push(`ingreso ${ingreso}`);
          } else {
            traza.push('sin fecha de ingreso');
          }

          // El régimen pensionario no está en esta pestaña: ver leerSeguridadSocial.
          await this.leerSeguridadSocial(page, s, t, marcoFicha, diagnostico, i === 0);
          if (t.regimen_pensionario) traza.push(t.regimen_pensionario);
        } else {
          traza.push('NO abrió la pestaña "Trabajador" — el sueldo no está en el resumen');
        }

        const vuelta = await this.volverAlPadron(page, s, urlPadron, i === 0 ? diagnostico : []);
        traza.push(vuelta);

        // Si no se pudo volver, la próxima vuelta del bucle corta igual: mejor dejar
        // dicho ACÁ cómo está hecho el botón que no se pudo pulsar, que descubrirlo
        // en otra sesión. La lupa mira el marco de la ficha, no la página entera.
        if (i === 0 && vuelta.startsWith('NO VOLVIÓ')) {
          await this.lupaSobre(this.marcoTregistro(page) ?? page, 'Retornar', diagnostico);
        }
        anotar();
      } catch (e: any) {
        traza.push(`EXCEPCIÓN: ${e?.message ?? e}`);
        anotar();
        await this.volverAlPadron(page, s, urlPadron).catch(() => {});
      }
    }

    diagnostico.push(`Sueldos leídos: ${leidos} de ${trabajadores.length}`);
  }

  /**
   * Lee el régimen pensionario de "Datos de Seguridad Social".
   *
   * POR QUÉ EXISTE: en la pestaña "Trabajador" no aparece ni "AFP" ni "ONP" — eso está
   * en otra sección, que la ficha muestra plegada (verificado en pantalla el
   * 01/09/2026, junto con "Datos de la Situación Educativa" y "Datos Tributarios"). El
   * código anterior lo buscaba en el texto de la pestaña laboral, o sea donde no está:
   * no iba a encontrarlo nunca y nadie se enteraba, porque no encontrar algo no da
   * error.
   *
   * PRIMERO SIN TOCAR NADA. `textoDeMarco` no filtra por visibilidad, así que si la
   * sección viene plegada pero montada en el DOM, su contenido YA está en el texto y no
   * hace falta ningún clic. Solo si ahí no aparece se intenta desplegarla. Esto importa
   * más de lo que parece: en la corrida del 01/09/2026 el único trabajador al que se le
   * desplegó la sección fue también el último que se pudo leer — después de esa ficha
   * no se volvió al padrón y las nueve restantes quedaron sin nada. Un clic de menos
   * dentro de la ficha de un cliente es un riesgo de menos, y para cuando esto corre el
   * sueldo —que es lo que fuimos a buscar— ya está leído.
   *
   * Nunca aborta: sin régimen el trabajador se importa igual y el usuario lo completa.
   */
  private async leerSeguridadSocial(
    page: Page,
    s: typeof SunatTregistroScrapingClient.SELECTORES,
    t: TrabajadorScrapeado,
    marcoFicha: Frame,
    diagnostico: string[],
    volcar: boolean,
  ): Promise<void> {
    try {
      let texto = await this.textoDeMarco(this.marcoTregistro(page) ?? marcoFicha);

      if (!this.marcarRegimen(texto, t)) {
        await this.intentarClic(
          page,
          (this.marcoTregistro(page) ?? marcoFicha).getByText(s.SECCION_SEGURIDAD_SOCIAL).first(),
          `sección ${s.SECCION_SEGURIDAD_SOCIAL}`,
          volcar ? diagnostico : [],
          700,
        );
        texto = await this.textoDeMarco(this.marcoTregistro(page) ?? marcoFicha);
        this.marcarRegimen(texto, t);
      }

      // El volcado se recorta DESDE la sección: la ficha entera no entra en el
      // diagnóstico, y el principio ya se volcó al leer la identificación.
      if (volcar) {
        const desde = texto.toLowerCase().indexOf(s.SECCION_SEGURIDAD_SOCIAL.toLowerCase());
        diagnostico.push(
          `Datos de Seguridad Social del primero: ${desde >= 0 ? texto.slice(desde, desde + 1200) : '(no se ubicó la sección) ' + texto.slice(0, 600)}`,
        );
      }

      // El CUSPP se valida antes de guardarlo: si la etiqueta agarró cualquier otra
      // cosa, mejor dejarlo vacío que meter basura en la ficha del trabajador.
      const cuspp = this.valorTrasEtiqueta(texto, 'CUSPP', ['Fecha', 'Régimen', 'Regimen', 'Tipo', 'Comisión', 'Comision', 'EsSalud']);
      if (cuspp && /^[A-Za-z0-9]{10,15}$/.test(cuspp)) t.cuspp = cuspp;
    } catch (e: any) {
      if (volcar) diagnostico.push(`No se pudo leer Datos de Seguridad Social: ${e?.message ?? e}`);
    }
  }

  /**
   * Marca AFP u ONP leyendo EL CAMPO "Régimen pensionario".
   *
   * Devuelve si encontró algo, que es lo que decide si hace falta desplegar la
   * sección o alcanza con lo que ya está leído.
   *
   * NO SE PUEDE BUSCAR "ONP" SUELTO EN LA PANTALLA. El volcado del 01/09/2026 mostró
   * por qué: la ficha trae fijo el rótulo "Cobertura Pensión: 1 ONP 2 Seguro Privado",
   * esté la persona en la ONP o no. Un `/\bONP\b/` sobre el texto entero marcaba en la
   * ONP a cualquiera, incluido quien no tiene régimen cargado. El valor de verdad es
   * el del campo: "DECRETO LEY 19990 - SISTEMA NACIONAL DE PENSIONES - ONP".
   */
  private marcarRegimen(texto: string, t: TrabajadorScrapeado): boolean {
    const valor = this.valorTrasEtiqueta(texto, 'Régimen pensionario', [
      'Consulta SBS', 'CUSPP', 'Fecha de Inicio', 'Validar SPP', 'Cobertura',
    ]) ?? this.valorTrasEtiqueta(texto, 'Regimen pensionario', [
      'Consulta SBS', 'CUSPP', 'Fecha de Inicio', 'Validar SPP', 'Cobertura',
    ]);
    if (!valor) return false;

    if (/\bAFP\b|\bSPP\b|PRIVADO DE PENSIONES|Sistema Privado/i.test(valor)) {
      t.regimen_pensionario = 'AFP';
      return true;
    }
    if (/\bONP\b|19990|SISTEMA NACIONAL/i.test(valor)) {
      t.regimen_pensionario = 'ONP';
      return true;
    }
    return false;
  }

  /**
   * Abre la ficha de un trabajador desde su fila del padrón.
   *
   * LAS ACCIONES SON ÍCONOS SIN TEXTO. En el volcado del 27/08/2026 cada fila salió
   * como "TRA · L.E / DNI - 40966442 · MORI SAAVEDRA JORGE LUIS · 13/07/1981 ·
   * Masculino · Activo · ·" — esas dos celdas vacías del final son los botones.
   * ⚠️ Y NO SON DOS BOTONES CUALESQUIERA. La captura del padrón del 01/09/2026 les
   * puso nombre: las dos últimas columnas son "Modificar" y "Eliminar", y la de
   * Eliminar es una X roja que DA DE BAJA al trabajador en el T-Registro real del
   * cliente. La versión anterior, al no encontrar el ícono por etiqueta, clickeaba
   * los elementos de la fila EMPEZANDO POR EL FINAL: el primero que habría probado
   * era exactamente esa X. Nunca llegó a correr, pero estaba escrito y armado.
   *
   * Así que acá no hay búsqueda por posición ni por etiqueta: se clickea el enlace
   * que llama a irModificar() y, si no está, se corta. Volver sin el sueldo de esa
   * persona es barato; un clic a ciegas sobre esa fila, no.
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

    // ÚNICO camino: el enlace que abre la ficha. En la fila conviven el ícono de
    // Modificar y la X de Eliminar, y este selector distingue al bueno por su
    // javascript:, que es lo único que los diferencia en el HTML.
    const enlace = fila.locator(s.ENLACE_FICHA).first();
    if (await this.intentarClic(page, enlace, `ficha ${t.numero_documento} [irModificar]`, diagnostico, 900)) return true;

    diagnostico.push(
      `No se encontró "${s.ENLACE_FICHA}" en la fila de ${t.numero_documento}. No se prueba ` +
      'nada más a propósito: la otra acción de esa fila es Eliminar.',
    );
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

        // Se sacan las fechas de la ventana ANTES de buscar el importe. Desde que
        // el patrón acepta enteros sin decimales (la ficha trae "2000" pelado), un
        // "01/11/2016" cerca de la etiqueta daría un sueldo de 1 sol.
        // La ventana se corta en el rótulo siguiente. Sin ese corte, con el campo
        // vacío llegaba hasta "Jornada laboral: 1 ..." y devolvía 1 como sueldo.
        let ventana = texto.slice(i, i + 120).replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, ' ');
        for (const rotulo of ['Establecimiento', 'Jornada', 'Cod. Local', 'Situación', 'Situacion', 'Entidad']) {
          const corte = ventana.indexOf(rotulo);
          if (corte > 0) ventana = ventana.slice(0, corte);
        }
        const m = ventana.match(s.PATRON_MONTO);
        if (m) return m[1].replace(/,/g, '');
      }
    }
    return null;
  }

  /**
   * Abre la pestaña "Trabajador" de la sección Categoría, que es donde vive lo
   * laboral: remuneración y fecha de ingreso.
   *
   * La ficha abre en "Resumen de Prestadores", que solo lista qué categorías tiene la
   * persona — ahí no hay ningún sueldo. Leer el sueldo sin entrar a esta pestaña era
   * buscarlo donde no está (27/08/2026).
   *
   * ESPERA Y VERIFICA, no clickea a ciegas. La ficha se abre por POST DENTRO del
   * iframe: cuando `intentarClic` da la página por cargada, la pestaña puede no estar
   * montada todavía. La versión anterior clickeaba tras una espera fija y, si el clic
   * "salía bien", daba la pestaña por abierta sin mirar qué había quedado en pantalla
   * — un clic que cayó en el lugar equivocado se leía igual que uno bueno, y el
   * trabajador terminaba sin sueldo y sin explicación. Eso es exactamente lo que le
   * pasó al PRIMERO de la lista el 01/09/2026: su ficha tenía el monto a la vista y
   * volvió vacío. Ahora se confirma que apareció el bloque "Datos laborales" y, si no
   * apareció, se reintenta una vez tras esperar.
   */
  private async abrirPestanaTrabajador(
    page: Page,
    s: typeof SunatTregistroScrapingClient.SELECTORES,
    marcoFicha: Frame,
    documento: string,
    traza: string[],
    diagnostico: string[],
  ): Promise<boolean> {
    for (let intento = 1; intento <= 2; intento++) {
      // El marco va EN LA DESCRIPCIÓN del clic. Sin eso el diagnóstico decía
      // "OK — clic en pestaña Trabajador [tab]" sin manera de saber si se había
      // pulsado la pestaña de la ficha o cualquier otra cosa del menú de SOL.
      for (const marco of this.marcosOrdenados(page, s)) {
        const donde = ` en ${this.donde(page, marco)}`;

        for (const rol of ['tab', 'link', 'button'] as const) {
          const l = marco.getByRole(rol, { name: s.PESTANA_TRABAJADOR, exact: true }).first();
          if (await this.intentarClic(page, l, `pestaña ${s.PESTANA_TRABAJADOR} [${rol}]${donde}`, diagnostico, 900)) {
            if (await this.esperarDatosLaborales(page, s, marcoFicha, documento, 9_000)) return true;
            traza.push(`clic en la pestaña [${rol}] sin la ficha poblada detrás`);
          }
        }

        const porTexto = marco.getByText(s.PESTANA_TRABAJADOR, { exact: true }).first();
        if (await this.intentarClic(page, porTexto, `pestaña ${s.PESTANA_TRABAJADOR} [texto]${donde}`, diagnostico, 900)) {
          if (await this.esperarDatosLaborales(page, s, marcoFicha, documento, 9_000)) return true;
          traza.push('clic en la pestaña [texto] sin la ficha poblada detrás');
        }
      }

      if (intento === 1) {
        traza.push('reintento de la pestaña tras esperar');
        await page.waitForTimeout(3000);
      }
    }
    return false;
  }

  /**
   * Lee el valor de un campo de la ficha POR SU ETIQUETA, del DOM y no del texto.
   *
   * ESTO EXISTE POR UN SUELDO DE 1 SOL. Leyendo el texto corrido de la pantalla, con
   * el campo del monto todavía vacío la ventana de búsqueda llegaba hasta el rótulo
   * de al lado —"Jornada laboral: 1 Jornada de trabajo máxima"— y se traía ese 1.
   * Un null se ve y se corrige; un 1 se importa y termina en una boleta. El
   * trabajador tenía 1130 en su ficha.
   *
   * Acotar a la celda de la etiqueta y a la siguiente es la parte que importa: el
   * valor del campo de al lado nunca puede colarse, esté vacío el nuestro o no.
   *
   * Devuelve el valor, o '' si la etiqueta está pero el campo está vacío (que es un
   * dato, no un fallo), o null si no se encontró la etiqueta.
   */
  private async valorDeCampo(marco: Frame, etiquetas: string[]): Promise<string | null> {
    return marco.evaluate((ets: string[]) => {
      const norm = (s: string | null) => (s || '')
        .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ').trim();
      const objetivos = ets.map(norm).filter(Boolean);

      // NO TODO <input> ES UN CAMPO. Dojo arma cada caja de texto con varios:
      //   <input class="dijitInputInner" value="2000">        ← el valor de verdad
      //   <input class="dijitValidationInner" value="Χ">      ← el ícono de validación
      // Tomar "el primero con valor" devolvía SIEMPRE esa Χ, y con ella el sueldo se
      // perdía en las once fichas. Esa Χ es la misma que se ve por toda la pantalla
      // en los volcados: no es basura del texto, son inputs de adorno.
      const valorEn = (caja: Element | null | undefined): string | null => {
        if (!caja) return null;

        const utiles = Array.from(caja.querySelectorAll('input'))
          .map((i) => i as HTMLInputElement)
          .filter((e) => {
            if (['button', 'submit', 'image', 'checkbox', 'radio'].includes(e.type)) return false;
            if (/validation|arrowbutton|spinner|downarrow|clear/i.test(String(e.className || ''))) return false;
            const v = (e.value || '').trim();
            if (!v) return false;
            // Un solo carácter que no es letra ni número es un adorno (Χ, ▼, ✕).
            return !(v.length <= 1 && !/[0-9a-zA-Z]/.test(v));
          });

        // Preferencias: el input propio de dijit, después cualquiera visible, y por
        // último uno oculto (dojo a veces guarda ahí el valor que se envía).
        const elegido = utiles.find((e) => /dijitInputInner/i.test(String(e.className || '')))
          ?? utiles.find((e) => e.type !== 'hidden')
          ?? utiles[0];
        return elegido ? (elegido.value || '').trim() : null;
      };

      for (const n of Array.from(document.querySelectorAll('td, th, label, span, div, b'))) {
        // Texto PROPIO del nodo: con textContent, cualquier contenedor grande
        // "contiene" la etiqueta y el campo que se encontraría sería otro.
        const propio = norm(Array.from(n.childNodes)
          .filter((c) => c.nodeType === 3)
          .map((c) => c.textContent)
          .join(' '));
        if (!propio || !objetivos.some((o) => propio.includes(o))) continue;

        const celda = n.closest('td') ?? n;
        return valorEn(celda) ?? valorEn(celda.nextElementSibling) ?? '';
      }
      return null;
    }, etiquetas);
  }

  /**
   * ¿La ficha está mostrando el bloque laboral, el que tiene el sueldo?
   *
   * Es la diferencia entre "el clic no dio error" y "la pantalla que buscábamos está
   * delante". Solo lo segundo sirve.
   */
  private async hayDatosLaborales(
    page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES, marcoFicha: Frame,
    documento: string,
  ): Promise<boolean> {
    const marco = this.marcoTregistro(page) ?? marcoFicha;
    const texto = await this.textoDeMarco(marco);

    // NO ALCANZA CON QUE ESTÉ EL TÍTULO "Datos laborales": el armazón de la ficha se
    // dibuja ANTES que los datos. La corrida del 01/09/2026 leyó una ficha con todos
    // los campos en blanco y se dio por buena.
    if (!/datos laborales/i.test(texto) || !texto.includes(documento)) return false;

    // Y TAMPOCO ALCANZA CON EL DNI. El documento vive en "Datos de Identificacion",
    // que se puebla ANTES que el bloque laboral: la ficha de DIOSES GONZALES pasó
    // este control con la identificación ya cargada y los datos laborales todavía
    // vacíos, así que el sueldo y la fecha salieron nulos mientras el régimen
    // pensionario —que se lee un instante después— sí llegó. Diez de once bien y uno
    // en blanco, sin ningún error.
    //
    // El marcador tiene que ser DEL PROPIO BLOQUE LABORAL. Se usa la fecha de inicio
    // del periodo laboral porque en el T-Registro es obligatoria para todo
    // trabajador: si no está, la pantalla no terminó de cargar. El monto no sirve
    // para esto — puede estar legítimamente vacío.
    const periodo = await this.valorDeCampo(marco, ['Periodo laboral']);
    return !!periodo && /^\d{2}\/\d{2}\/\d{4}/.test(periodo.trim());
  }

  /**
   * Espera a que el bloque laboral termine de poblarse, sondeando.
   *
   * Una sola comprobación justo después del clic es una foto en el peor momento: la
   * ficha se arma por partes y cada trabajador tarda distinto. Sondear sale apenas
   * los datos están, y solo espera de verdad cuando hace falta.
   */
  private async esperarDatosLaborales(
    page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES, marcoFicha: Frame,
    documento: string, ms: number,
  ): Promise<boolean> {
    const hasta = Date.now() + ms;
    for (;;) {
      if (await this.hayDatosLaborales(page, s, marcoFicha, documento)) return true;
      if (Date.now() >= hasta) return false;
      await page.waitForTimeout(800);
    }
  }

  /**
   * Vuelve del detalle al listado, y DICE CÓMO lo consiguió.
   *
   * EL ORDEN ES EL RESULTADO DE TRES SESIONES GASTADAS (01/09/2026):
   *
   *  1. RECARGAR EL IFRAME con la URL del padrón. La app del T-Registro vive en su
   *     propio iframe (prestadores.htm?hc&token=…) y esa URL ya la conocemos: es
   *     donde encontramos el padrón la primera vez. Es una navegación de solo
   *     lectura, determinista, y no depende de acertarle a ningún botón. Va PRIMERO
   *     por eso, no por descarte.
   *
   *  2. El botón "Retornar" de la ficha, buscado SOLO dentro del marco del
   *     T-Registro y sin escaneo. La versión anterior lo buscaba con `clicEnMenu`,
   *     que está hecho para el árbol del menú: por cada etiqueta ('Retornar',
   *     'Regresar', 'Volver', 'Cancelar') y por cada marco recorre hasta 600
   *     elementos pidiendo el innerText de uno en uno. Son miles de idas y vueltas
   *     al navegador POR FICHA, y encima terminaban en nada. Eso —no el scraping—
   *     fue lo que llevó la petición por encima del techo de tiempo.
   *
   *  3. Rehacer el salto del menú. Último, porque ya se comprobó que el clic sale
   *     "OK" y el iframe sigue mostrando la ficha: que el menú responda no quiere
   *     decir que la app de adentro se haya movido.
   */
  private async volverAlPadron(
    page: Page,
    s: typeof SunatTregistroScrapingClient.SELECTORES,
    urlPadron: string | null,
    diagnostico: string[] = [],
  ): Promise<string> {
    const marco = this.marcoTregistro(page);

    if (urlPadron && marco) {
      const fallo = await marco
        .goto(urlPadron, { waitUntil: 'domcontentloaded', timeout: 20_000 })
        .then(() => null)
        .catch((e: any) => String(e?.message ?? e).split(String.fromCharCode(10))[0]);
      if (fallo) diagnostico.push(`No se pudo recargar el iframe del padrón: ${fallo.slice(0, 140)}`);
      if (await this.esperarPadron(page, s, 10_000)) return 'volvió recargando el iframe';
    }

    // Búsqueda ACOTADA: el marco de la ficha y nada más, por rol y por texto exacto.
    // Sin el escaneo elemento por elemento, que es lo caro.
    const marcoFicha = this.marcoTregistro(page) ?? page.mainFrame();
    for (const etiqueta of s.ACCIONES_VOLVER) {
      const candidatos = [
        marcoFicha.getByRole('button', { name: etiqueta }).first(),
        marcoFicha.getByRole('link', { name: etiqueta }).first(),
        marcoFicha.getByText(etiqueta, { exact: true }).first(),
      ];
      for (const c of candidatos) {
        if (await this.intentarClic(page, c, `${etiqueta} (ficha)`, diagnostico, 900)) {
          if (await this.esperarPadron(page, s, 10_000)) return `volvió por "${etiqueta}"`;
        }
      }
    }

    if (await this.esperarPadron(page, s, 2_000)) return 'volvió solo';

    await this.clicEnMenu(page, s.MENU_REGISTRO_INDIVIDUAL, diagnostico);
    return (await this.esperarPadron(page, s, 10_000))
      ? 'volvió rehaciendo el menú'
      : 'NO VOLVIÓ al padrón';
  }

  /**
   * Sondea hasta que el padrón esté en pantalla, o se acabe el tiempo.
   *
   * La grilla del T-Registro es dojox y se llena por XHR: "está cargada la página" y
   * "están las filas" son dos momentos distintos, y entre uno y otro puede haber
   * varios segundos.
   */
  private async esperarPadron(
    page: Page, s: typeof SunatTregistroScrapingClient.SELECTORES, ms: number,
  ): Promise<boolean> {
    const hasta = Date.now() + ms;
    for (;;) {
      if (await this.hayPadron(page, s)) return true;
      if (Date.now() >= hasta) return false;
      await page.waitForTimeout(750);
    }
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
  private async lupaSobre(page: Page | Frame, aguja: string, diagnostico: string[]) {
    try {
      // Page o Frame: la ficha vive DENTRO del iframe del T-Registro, así que mirar
      // solo la página principal era mirar el armazón del menú y nada más.
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

import { Injectable, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Response } from 'express';
import { JSDOM } from 'jsdom';
import juice = require('juice');
import htmlToPdfmake = require('html-to-pdfmake');
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { PDF_THEME, tamanoTablaPorFilas } from './pdf-theme';
// Roboto (registro en pdfmake + Buffers crudos para medir con fontkit) y las políticas de
// acceso viven en pdf-fuentes.ts — pdfmake 0.3 es un singleton, ver allí el porqué.
import { pdfMake, BUFFERS_ROBOTO } from './pdf-fuentes';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fontkit = require('@foliojs-fork/fontkit');

// Reemplazo de Chromium/Puppeteer (fallaba en hosting compartido: /tmp montado con noexec
// impide ejecutar el binario de @sparticuz/chromium incluso redirigiendo TMPDIR). pdfmake
// genera el PDF con JS puro, sin proceso externo ni navegador — corre igual en local y en
// hosting compartido.
//
// Limitación conocida: pdfmake no ejecuta JavaScript, así que los reportes que dibujan
// gráficos con Chart.js en el navegador (buscar `__pdfChartsReady` en el proyecto) generan
// el PDF sin esos gráficos. Pendiente definir alternativa (renderizar el chart como imagen
// en el servidor) para esos reportes puntuales.
//
// Tipografía única de todos los reportes PDF: pdfmake solo puede usar fuentes registradas
// por nombre (no lee el font-family que cada reporte pone en su <style>). Roboto va embebida
// como base64 en fonts-data.ts y se registra en el sistema de archivos VIRTUAL de pdfmake
// (ver pdf-fuentes.ts) — así no depende de que el build copie .ttf al dist.
// Para cambiar la letra de TODOS los reportes de una sola vez: regenerar fonts-data.ts con
// otra fuente (normal/bold/italic/bolditalic). Ningún reporte necesita tocarse.
const FUENTE_POR_DEFECTO = 'Roboto';

// Tamaño A4 en puntos PDF (72pt/in): 8.27in x 11.69in. Usado para calcular el ancho disponible
// de las tablas (forzarAnchosDeColumnaUniformes) — si el día de mañana cambia pageSize o
// pageMargins más abajo, hay que actualizar esto también.
const ANCHO_A4_PT = 595.28;
const ALTO_A4_PT = 841.89;
const MARGEN_PT = 20;

// Mismo factor que usa html-to-pdfmake internamente para convertir font-size de px (CSS) a pt
// (index.js: `Math.round(val * 0.75292857248934)`) — se reutiliza acá para que la medición de
// ancho de columna use el mismo tamaño en pt que el que realmente se va a dibujar.
const PX_A_PT = 0.75292857248934;

// ---------------------------------------------------------------------------
// Cola global de generación de PDF
//
// Generar un PDF levanta un DOM simulado (JSDOM) y arma el documento COMPLETO en memoria
// antes de enviarlo. Dos o tres reportes pesados generándose a la vez SUMAN esa memoria, y
// si se pasa del límite del plan el proceso Node muere: se cae el sistema para TODOS, no
// solo para quien pidió el reporte.
//
// Con esta cola nunca se genera más de un PDF a la vez. El segundo espera su turno y sale
// unos segundos después — la memoria nunca se acumula. Si además se juntan demasiados en
// espera, se rechazan con un mensaje claro en vez de dejar al usuario colgado hasta que el
// navegador corte solo.
//
// Vive a nivel de módulo (no como propiedad de la clase) a propósito: así la cola es una
// sola aunque Nest instancie PdfHtmlService en varios módulos.
// ---------------------------------------------------------------------------

/** Cuántos PDF pueden estar generándose o esperando turno antes de empezar a rechazar. */
const MAX_EN_COLA = 4;

/** Cuántos hay ahora mismo generándose o esperando. */
let enCola = 0;

/** Promesa encadenada: cada PDF nuevo se engancha al final de esta fila. */
let turno: Promise<void> = Promise.resolve();

@Injectable()
export class PdfHtmlService {
  private readonly logger = new Logger(PdfHtmlService.name);
  // Mismos archivos de fuente que pdfmake usa para dibujar, cargados aparte con fontkit para
  // poder medir el ancho real del texto (ver anchoRealDeCelda) sin duplicar los .ttf.
  private readonly fontMedidaNormal = fontkit.create(BUFFERS_ROBOTO.normal);
  private readonly fontMedidaBold = fontkit.create(BUFFERS_ROBOTO.bold);

  // html-to-pdfmake solo traduce `background-color` a `fillColor` cuando está directo en
  // <td>/<th>. Los reportes definen el color de fila (zebra striping, fila de totales) con
  // `tr:nth-child(even)` / `.totales` en un <style>, y juice() los deja inlineados en el
  // <tr> — hay que empujar ese color a cada celda hija o se pierde el fondo de la fila.
  private propagarFondoDeFilaACeldas(html: string): string {
    const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
    const document = dom.window.document;
    document.querySelectorAll('tr').forEach((tr) => {
      const fondoFila = (tr as unknown as HTMLElement).style.backgroundColor;
      if (!fondoFila) return;
      tr.querySelectorAll('td, th').forEach((celda) => {
        const el = celda as unknown as HTMLElement;
        if (!el.style.backgroundColor) {
          el.style.backgroundColor = fondoFila;
        }
      });
    });
    return document.body.innerHTML;
  }

  // html-to-pdfmake no sabe dibujar `display:flex`/`display:grid` (tarjetas de KPIs, grillas de
  // filtros, etc.) — apila los hijos en vertical y pierde el acomodo en columnas, aunque sí
  // conserva border/background de cada tarjeta individual (por eso el problema es solo de
  // ACOMODO, no de estilo). Sí guarda `display`/`gridTemplateColumns`/`gap` como propiedades
  // crudas en cada nodo (aunque no las use), así que podemos detectar esos tramos y convertirlos
  // a `columns` nativo de pdfmake — sin que cada reporte tenga que dejar de usar CSS grid/flex.
  private expandirFlexGrid(lista: unknown[]): unknown[] {
    // primero, recursar en hijos (tablas/stacks anidados) por si el patrón aparece más adentro
    lista.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const it = item as { stack?: unknown[]; table?: { body?: unknown[][] } };
      if (Array.isArray(it.stack)) it.stack = this.expandirFlexGrid(it.stack);
      if (it.table?.body) {
        it.table.body.forEach((fila) =>
          fila.forEach((celda) => {
            const c = celda as { stack?: unknown[] };
            if (Array.isArray(c.stack)) c.stack = this.expandirFlexGrid(c.stack);
          }),
        );
      }
    });

    const resultado: unknown[] = [];
    let i = 0;
    while (i < lista.length) {
      const item = lista[i] as Record<string, unknown> | null;
      const display = item && (item.display === 'grid' || item.display === 'flex') ? (item.display as string) : null;
      if (!display) {
        resultado.push(lista[i]);
        i++;
        continue;
      }

      // recolectar el tramo completo de hermanos que pertenecen al mismo contenedor flex/grid
      // (mismo display + mismo gridTemplateColumns — html-to-pdfmake repite estas props en
      // CADA hijo del contenedor, así que sirve como firma para agruparlos)
      const gridTemplateColumns = item?.gridTemplateColumns as string | undefined;
      const gap = typeof item?.gap === 'number' ? (item.gap as number) : 4;
      const tramo: Record<string, unknown>[] = [];
      let j = i;
      while (j < lista.length) {
        const actual = lista[j] as Record<string, unknown> | null;
        if (!actual || actual.display !== display || actual.gridTemplateColumns !== gridTemplateColumns) break;
        tramo.push(actual);
        j++;
      }

      // html-to-pdfmake mete un nodo "text: ' '" en blanco entre cada hijo real del contenedor
      // (separador de bloque) — se descartan, solo interesan los hijos con contenido real.
      const reales = tramo.filter((n) => n.nodeName !== undefined);
      if (reales.length === 0) {
        i = j;
        continue;
      }
      reales.forEach((n) => {
        delete n.display;
        delete n.gridTemplateColumns;
        delete n.gap;
      });

      let numColumnas = reales.length;
      if (display === 'grid' && gridTemplateColumns) {
        const repetido = gridTemplateColumns.match(/repeat\((\d+)/);
        if (repetido) {
          numColumnas = parseInt(repetido[1], 10);
        } else {
          const tokens = gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
          if (tokens.length > 0) numColumnas = tokens.length;
        }
      }

      // pdfmake solo puede dibujar caja completa (borde + fondo) DENTRO de celdas de tabla — un
      // `background`/`border` puesto en un item de `columns` normal no dibuja ninguna caja (el
      // "background" ahí solo resalta el propio texto, no el padding de la tarjeta). Por eso las
      // tarjetas de KPI ("Total dinero" en su cajita gris) necesitan ir como tabla de 1 fila con
      // las líneas de grilla apagadas — no como `columns` sueltas, que se ve bien solo para pares
      // etiqueta:valor sin caja (ej. "Estado: Pendiente...").
      const tieneCaja = reales.some((n) => n.background !== undefined || n.border !== undefined);

      if (display === 'flex' && !tieneCaja) {
        resultado.push({ columns: reales, columnGap: gap });
        i = j;
        continue;
      }

      for (let k = 0; k < reales.length; k += numColumnas) {
        const filaItems = reales.slice(k, k + numColumnas);
        while (filaItems.length < numColumnas) filaItems.push({ text: '' });
        if (tieneCaja) {
          filaItems.forEach((celda) => {
            const c = celda as Record<string, unknown>;
            if (c.background !== undefined && c.fillColor === undefined) {
              c.fillColor = c.background;
              delete c.background;
            }
          });
          // Sin gap real entre celdas, dos tarjetas vecinas del mismo color de fondo se ven
          // como una sola barra continua (no hay línea de grilla que las separe, la quitamos
          // arriba a propósito). Se intercala una celda "espaciadora" en blanco de ancho fijo
          // entre cada tarjeta para simular el `gap` del CSS original.
          const filaConEspaciadores: unknown[] = [];
          const anchosConEspaciadores: unknown[] = [];
          filaItems.forEach((celda, idx) => {
            filaConEspaciadores.push(celda);
            anchosConEspaciadores.push('*');
            if (idx < filaItems.length - 1) {
              filaConEspaciadores.push({ text: '' });
              anchosConEspaciadores.push(gap);
            }
          });
          resultado.push({
            table: { widths: anchosConEspaciadores, body: [filaConEspaciadores] },
            // defaultBorder:false = las celdas espaciadoras (sin `.border` propio) no dibujan
            // línea; las tarjetas reales sí la dibujan porque traen su propio `cell.border`
            // (ver tableProcessor.js: `leftCellBorder = cell.border ? cell.border[0] :
            // this.layout.defaultBorder`) — con esto cada tarjeta mantiene su borde propio y los
            // espacios entre ellas quedan sin recuadro.
            // vLineColor/hLineColor: cuando pdfmake no encuentra `borderColor` propio en ninguna
            // de las 2 celdas vecinas de una línea (pasa en algunos bordes junto a una celda
            // espaciadora) cae a este color por defecto — blanco en vez del negro por defecto de
            // pdfmake, para que esa línea "fantasma" quede invisible contra la página en vez de
            // aparecer como una rayita negra suelta.
            layout: {
              defaultBorder: false,
              hLineWidth: () => 1,
              vLineWidth: () => 1,
              hLineColor: () => '#ffffff',
              vLineColor: () => '#ffffff',
              paddingLeft: () => 4,
              paddingRight: () => 4,
              paddingTop: () => 4,
              paddingBottom: () => 4,
            },
            marginBottom: gap,
          });
        } else {
          resultado.push({ columns: filaItems, columnGap: gap, marginBottom: gap });
        }
      }
      i = j;
    }
    return resultado;
  }

  // Ancho real en puntos de la LÍNEA MÁS ANCHA dentro de una celda (medido con las métricas de
  // la fuente, no adivinado contando caracteres). Una celda con <br> (ej. "LUIS REYNA" / "B8A-909
  // | DOBLE") arma en html-to-pdfmake un solo nodo `text: [...]` con un hijo `{text:'\n',
  // nodeName:'BR'}` en medio — si se concatena todo el texto y se mide de un tirón, esas dos
  // líneas cortas se miden como si fueran una sola línea larga y se sobreestima brutal el ancho
  // que la columna necesita. Acá se recorre el árbol acumulando ancho por línea (cortando en cada
  // salto) y se devuelve solo la línea más ancha — que es la que de verdad puede desbordar.
  // `bold`/`fontSize`/`textTransform` se heredan del nodo padre hacia los hijos (igual que hace
  // pdfmake al dibujar), porque `html-to-pdfmake` los deja en el nodo que abrió el <strong>/<span>,
  // no en el <td> completo.
  // `soloPalabra=true` mide la PALABRA más larga (corta también en espacios, no solo en `\n`) en
  // vez de la línea más larga — sirve para calcular el piso mínimo de una columna (ver
  // `forzarAnchosDeColumnaUniformes`): pdfmake no sabe partir una palabra a la mitad al envolver
  // texto contra un ancho de columna angosto, así que si la columna queda MÁS angosta que su
  // palabra más larga, esa palabra se corta character por character («PENDIENTE» → «PENDIE» +
  // «NTE») en vez de solo pasar a la siguiente línea.
  private anchoMaximoLineaDeCelda(celda: unknown, tamanoFontPorDefectoPt: number, soloPalabra = false): number {
    let anchoLineaActual = 0;
    let anchoLineaMax = 0;

    const medirTexto = (texto: string, bold: boolean, tamanoPt: number, mayuscula: boolean) => {
      const lineas = soloPalabra ? texto.split(/\s+/) : texto.split('\n');
      lineas.forEach((linea, idx) => {
        if (idx > 0) {
          anchoLineaMax = Math.max(anchoLineaMax, anchoLineaActual);
          anchoLineaActual = 0;
        }
        if (!linea) return;
        const font = bold ? this.fontMedidaBold : this.fontMedidaNormal;
        const layout = font.layout(mayuscula ? linea.toUpperCase() : linea);
        anchoLineaActual += (layout.advanceWidth / font.unitsPerEm) * tamanoPt;
      });
    };

    const recorrer = (nodo: unknown, boldHeredado: boolean, tamanoHeredadoPt: number, mayusculaHeredada: boolean) => {
      if (nodo == null) return;
      if (typeof nodo === 'string') {
        medirTexto(nodo, boldHeredado, tamanoHeredadoPt, mayusculaHeredada);
        return;
      }
      if (Array.isArray(nodo)) {
        nodo.forEach((hijo) => recorrer(hijo, boldHeredado, tamanoHeredadoPt, mayusculaHeredada));
        return;
      }
      if (typeof nodo === 'object') {
        const n = nodo as { text?: unknown; bold?: boolean; fontSize?: number; textTransform?: string };
        const bold = n.bold ?? boldHeredado;
        const tamanoPt = n.fontSize ?? tamanoHeredadoPt;
        const mayuscula = n.textTransform === 'uppercase' || (n.textTransform === undefined && mayusculaHeredada);
        if (typeof n.text === 'string') {
          medirTexto(n.text, bold, tamanoPt, mayuscula);
        } else if (Array.isArray(n.text)) {
          recorrer(n.text, bold, tamanoPt, mayuscula);
        }
      }
    };

    recorrer(celda, false, tamanoFontPorDefectoPt, false);
    return Math.max(anchoLineaMax, anchoLineaActual);
  }

  // Último recurso cuando ni el piso de palabra completa alcanza (demasiadas columnas para la
  // página, ej. 20+): en vez de dejar que `forzarAnchosDeColumnaUniformes` angoste una columna por
  // debajo de su propia palabra y pdfmake la corte a la mitad, se achica el `fontSize` de TODA la
  // tabla por `factor` — letra más chica pero cada palabra sigue completa. Fija un tamaño explícito
  // en cada nodo de texto (multiplicando lo heredado del padre si no traía uno propio) para que
  // quede consistente sin importar si el tamaño venía de un `style` inline o del `defaultStyle`.
  private escalarFuenteCelda(nodo: unknown, factor: number, tamanoHeredadoPt: number): void {
    if (nodo == null) return;
    if (Array.isArray(nodo)) {
      nodo.forEach((hijo) => this.escalarFuenteCelda(hijo, factor, tamanoHeredadoPt));
      return;
    }
    if (typeof nodo === 'object') {
      const n = nodo as { text?: unknown; fontSize?: number };
      const tamanoPropio = typeof n.fontSize === 'number' ? n.fontSize : tamanoHeredadoPt;
      if (Array.isArray(n.text)) {
        this.escalarFuenteCelda(n.text, factor, tamanoPropio);
      }
      n.fontSize = tamanoPropio * factor;
    }
  }

  // Estandariza el tamaño de letra de TODA tabla de datos según su cantidad de filas — un
  // reporte de 3 filas y uno de 60 no deberían verse con la misma letra. Antes cada service
  // tenía que acordarse de calcular esto en su propio <style> (fácil de olvidar, fácil de dejar
  // desactualizado); ahora es automático para cualquier reporte que pase por generarPdf(), sin
  // que el HTML de origen tenga que declarar ningún font-size — se FIJA el tamaño absoluto en
  // cada celda (fila 0 = encabezado, con thead) ignorando lo que haya traído el CSS/inline.
  // Corre DESPUÉS de `forzarAnchosDeColumnaUniformes` (que ya puede haber achicado la fuente por
  // ancho de columna, no por cantidad de filas) — si ambos exigen achicar, gana el más chico.
  private ajustarTamanoPorCantidadDeFilas(nodo: unknown): void {
    if (Array.isArray(nodo)) {
      nodo.forEach((hijo) => this.ajustarTamanoPorCantidadDeFilas(hijo));
      return;
    }
    if (!nodo || typeof nodo !== 'object') return;
    const n = nodo as { table?: { body?: unknown[][] }; stack?: unknown[]; columns?: unknown[] };
    if (n.table?.body?.length) {
      const filas = n.table.body;
      // Tablas de 1 columna (banners de título) no son tablas de datos — no se tocan.
      if ((filas[0]?.length ?? 0) > 1) {
        const { bodySize, headerSize } = tamanoTablaPorFilas(filas.length - 1);
        filas.forEach((fila, indiceFila) => {
          const tamanoDestino = (indiceFila === 0 ? headerSize : bodySize) * PX_A_PT;
          fila.forEach((celda) => this.fijarTamanoFuenteCeldaSiMenor(celda, tamanoDestino));
        });
      }
    }
    if (n.stack) this.ajustarTamanoPorCantidadDeFilas(n.stack);
    if (n.columns) this.ajustarTamanoPorCantidadDeFilas(n.columns);
  }

  // Fija el fontSize de la celda al tamaño calculado por cantidad de filas — pero solo si ESE
  // tamaño es más chico que el que ya tenía (nunca agranda una letra que `escalarFuenteCelda` ya
  // redujo por ancho de columna; entre los dos achiques gana el que deje la letra más chica).
  private fijarTamanoFuenteCeldaSiMenor(nodo: unknown, tamanoDestinoPt: number): void {
    if (nodo == null) return;
    if (Array.isArray(nodo)) {
      nodo.forEach((hijo) => this.fijarTamanoFuenteCeldaSiMenor(hijo, tamanoDestinoPt));
      return;
    }
    if (typeof nodo === 'object') {
      const n = nodo as { text?: unknown; fontSize?: number };
      if (Array.isArray(n.text)) this.fijarTamanoFuenteCeldaSiMenor(n.text, tamanoDestinoPt);
      n.fontSize = typeof n.fontSize === 'number' ? Math.min(n.fontSize, tamanoDestinoPt) : tamanoDestinoPt;
    }
  }

  // pdfmake solo puede dibujar con fuentes registradas en FONTS (acá arriba, solo "Roboto"). Si
  // un reporte pone en su CSS un font-family que html-to-pdfmake logra mapear a otro nombre (ej.
  // `font-family: 'Courier New', monospace` → intenta usar una fuente "CourierNew" que no existe
  // en el motor), pdfmake truena entero: "Font 'CourierNew' ... is not defined". Como la decisión
  // es que TODOS los reportes comparten una sola tipografía centralizada (ver FONTS arriba),
  // recorremos el árbol completo y borramos cualquier `font` que no sea el registrado — así el
  // font-family que use cada reporte en su HTML es puramente decorativo/ignorado, nunca puede
  // romper la generación del PDF.
  private quitarFuentesNoRegistradas(nodo: unknown): void {
    if (Array.isArray(nodo)) {
      nodo.forEach((hijo) => this.quitarFuentesNoRegistradas(hijo));
      return;
    }
    if (nodo && typeof nodo === 'object') {
      const n = nodo as Record<string, unknown>;
      if (typeof n.font === 'string' && n.font !== FUENTE_POR_DEFECTO) {
        delete n.font;
      }
      for (const valor of Object.values(n)) {
        if (valor && typeof valor === 'object') this.quitarFuentesNoRegistradas(valor);
      }
    }
  }

  // Sin `widths` explícito, pdfmake calcula el ancho de cada columna en base al contenido más
  // ancho SIN quebrar línea — no en base al header. Con 7-8 columnas en A4 horizontal eso deja
  // headers largos ("Logística (Chofer/Tracto)") partidos en 2 líneas mientras headers cortos
  // ("Peso Neto") quedan en 1 sola, aunque el font-size sea idéntico en ambos — se ve
  // inconsistente. Repartir el ancho en partes IGUALES tampoco alcanza: un header largo se sigue
  // partiendo aunque se achique la letra, porque el problema es de ancho de columna, no de tamaño.
  // Repartimos el ancho disponible de la página proporcional al ancho REAL (medido) que necesita
  // cada columna — tomando el máximo entre su header Y su contenido real en el cuerpo (antes solo
  // se medía el header: una columna con header corto pero datos anchos, ej. "Cobro Servicios" con
  // montos "S/ 2086.14", terminaba angosta y el texto se cortaba contra el borde derecho de la
  // página). Se limita a las primeras `MAX_FILAS_MEDIDAS` filas del cuerpo por performance en
  // exports grandes (5000 filas) — el ancho típico de una columna ya se estabiliza con una muestra,
  // no hace falta medir la tabla completa. Nota: esta versión de pdfmake (@foliojs-fork) NO soporta
  // el formato "2*" de otros forks para pesos — solo reconoce el string '*' literal
  // (columnCalculator.js: `column.width === '*'`) — cualquier otro string ahí rompe el cálculo de
  // layout más adelante. Por eso acá se calculan puntos (pt) reales en vez de strings con peso.
  // pdfmake dibuja cada celda visualmente MÁS ancha que el número exacto que le damos en
  // `table.widths` — medido empíricamente comparando los rectángulos de fondo (`re...f`) del PDF
  // ya generado contra los anchos que esta función calculó: ~9pt de más POR COLUMNA, sin importar
  // el tamaño de la columna (una de 32pt sale en 41pt, una de 35pt sale en 44pt — la diferencia es
  // siempre +9, no un porcentaje). Este overhead no está documentado y no se pudo aislar a un solo
  // mecanismo (borde, gap entre columnas, redondeo interno de `columnCalculator.js`), pero es
  // CONSTANTE por columna — por eso un colchón fijo (un solo número para toda la tabla) nunca
  // alcanza cuando hay muchas columnas: con 8 columnas el excedente total es ~72pt (invisible),
  // con 46 columnas es ~414pt (desborda la página entera). La única forma correcta de compensarlo
  // es descontar `SOBRECOSTO_POR_COLUMNA_PT * numColumnas` del presupuesto ANTES de repartirlo.
  private static readonly SOBRECOSTO_POR_COLUMNA_PT = 9; // 9pt medido exacto, sin colchón extra

  private forzarAnchosDeColumnaUniformes(nodo: unknown, anchoPaginaCompletoPt: number, anchosColumnas?: number[]): void {
    const MAX_FILAS_MEDIDAS = 200;
    if (Array.isArray(nodo)) {
      nodo.forEach((hijo) => this.forzarAnchosDeColumnaUniformes(hijo, anchoPaginaCompletoPt, anchosColumnas));
      return;
    }
    if (nodo && typeof nodo === 'object') {
      const n = nodo as { table?: { body?: unknown[][]; widths?: unknown }; stack?: unknown; columns?: unknown; margin?: unknown };
      if (n.table?.body?.length && !n.table.widths) {
        const filaEncabezado = n.table.body[0] ?? [];
        const numColumnas = filaEncabezado.length;

        // Tablas de 1 sola columna (banner del título de cada reporte) SIEMPRE ocupan el ancho
        // completo de la página, sin descuentos — el overhead por columna no aplica igual (no hay
        // bordes internos entre columnas) y el banner debe tocar ambos márgenes, no quedar
        // encogido como si fuera parte de la tabla de datos.
        if (numColumnas === 1) {
          n.table.widths = [Math.floor(anchoPaginaCompletoPt)];
          if (n.stack) this.forzarAnchosDeColumnaUniformes(n.stack, anchoPaginaCompletoPt, anchosColumnas);
          if (n.columns) this.forzarAnchosDeColumnaUniformes(n.columns, anchoPaginaCompletoPt, anchosColumnas);
          if (n.table?.body) this.forzarAnchosDeColumnaUniformes(n.table.body, anchoPaginaCompletoPt, anchosColumnas);
          return;
        }

        // Presupuesto real para el reparto de columnas: ancho completo de la página, menos un
        // colchón fijo de seguridad, menos el sobrecosto de renderizado que cada columna agrega
        // por su cuenta (ver comentario de `SOBRECOSTO_POR_COLUMNA_PT` arriba).
        const colchonFijoPt = 6;
        const anchoDisponiblePt = Math.max(
          100,
          anchoPaginaCompletoPt - colchonFijoPt - PdfHtmlService.SOBRECOSTO_POR_COLUMNA_PT * numColumnas,
        );
        // Pesos fijos explícitos (opt-in por reporte, ver `opciones.anchosColumnas` de
        // `generarPdf`): se identifica la tabla objetivo por cantidad de columnas (una tabla de
        // banner de 1 columna nunca calza con un array de 8 pesos) y se calculan puntos
        // directamente proporcionales al peso — SIN medir texto con fontkit. Existe para reportes
        // donde el cálculo automático (basado en medir el texto real con fontkit) da un resultado
        // distinto entre el entorno de desarrollo y el de producción del cliente (fuentes/Node
        // distintos) — con pesos fijos el resultado es 100% determinístico sin importar el
        // entorno.
        if (anchosColumnas && anchosColumnas.length === numColumnas) {
          const sumaPesos = anchosColumnas.reduce((a, b) => a + b, 0);
          n.table.widths = anchosColumnas.map((peso) => Math.floor((peso / sumaPesos) * anchoDisponiblePt));
        } else if (numColumnas > 0) {
          // Colchón de seguridad generoso: el ancho medido con fontkit se acerca al real pero no
          // es idéntico al que usa pdfmake internamente para decidir si envuelve línea — con poco
          // margen, una celda puede terminar "por muy poco" necesitando 2 líneas, y pdfmake tiene
          // un bug real donde, si MÁS DE UNA celda de la misma fila envuelve a la vez, el
          // contenido de alguna se pierde por completo (no solo se ve mal, desaparece). Preferimos
          // quedarnos cortos en proporción (una columna se ve un poco más angosta de lo ideal)
          // antes que arriesgar ese bug.
          const paddingCeldaPt = 30;
          const filasAMedir = n.table.body.slice(0, MAX_FILAS_MEDIDAS);

          // Piso mínimo por columna = su palabra más larga + padding. Si el reparto proporcional
          // de más abajo deja una columna por debajo de este piso, pdfmake corta esa palabra a la
          // mitad al envolver en vez de solo pasarla a la siguiente línea (ver comentario de
          // `anchoMaximoLineaDeCelda`) — con muchas columnas (8+) el reparto proporcional puro
          // puede angostar de más a las columnas de texto corto (ej. "Estado", "PENDIENTE"). El
          // padding es un PARÁMETRO (no una constante) porque con MUCHAS columnas (20+) el colchón
          // fijo por sí solo (30pt × N columnas) puede superar toda la página sin contar ni una
          // letra — cuando toca achicar la fuente más abajo, el padding se achica junto con ella.
          const medir = (paddingPt: number) => {
            const necesarios = new Array(numColumnas).fill(0);
            const pisos = new Array(numColumnas).fill(0);
            filasAMedir.forEach((fila, indiceFila) => {
              fila.forEach((celda, indiceColumna) => {
                if (indiceColumna >= numColumnas) return;
                const tamanoPorDefecto =
                  (indiceFila === 0 ? PDF_THEME.TABLE_HEADER_SIZE : PDF_THEME.BODY_SIZE) * PX_A_PT;
                const necesario = this.anchoMaximoLineaDeCelda(celda, tamanoPorDefecto) + paddingPt;
                if (necesario > necesarios[indiceColumna]) necesarios[indiceColumna] = necesario;
                const piso = this.anchoMaximoLineaDeCelda(celda, tamanoPorDefecto, true) + paddingPt;
                if (piso > pisos[indiceColumna]) pisos[indiceColumna] = piso;
              });
            });
            return { necesarios, pisos, sumaNecesaria: necesarios.reduce((a, b) => a + b, 0), sumaPisos: pisos.reduce((a, b) => a + b, 0) };
          };

          let { necesarios, pisos, sumaNecesaria, sumaPisos } = medir(paddingCeldaPt);

          if (sumaPisos > anchoDisponiblePt) {
            // Ni siquiera el piso de palabra completa cabe (demasiadas columnas, ej. 20+): en vez
            // de angostar una columna por debajo de su palabra (pdfmake la partiría a la mitad),
            // se achica el fontSize de TODA la tabla hasta que sí quepa — letra más chica pero
            // ninguna palabra se corta. El ancho medido con fontkit es exactamente proporcional al
            // tamaño de fuente (ver `anchoMaximoLineaDeCelda`), así que en vez de un factor
            // "estimado" con colchones inventados, se busca por bisección el factor MÁS GRANDE
            // (letra lo más legible posible) que efectivamente entra en `anchoDisponiblePt` — el
            // padding también se achica con el mismo factor (piso 4pt: con 40+ columnas ni el
            // padding solo entra si no se achica también).
            const { pisos: pisosSinPadding } = medir(0);
            const sumaPisosConFactor = (f: number) =>
              pisosSinPadding.reduce((acc, p) => acc + p * f, 0) + numColumnas * Math.max(4, paddingCeldaPt * f);

            let factor = 1;
            if (sumaPisosConFactor(1) > anchoDisponiblePt) {
              let lo = 0.01;
              let hi = 1;
              for (let iter = 0; iter < 30; iter++) {
                const mid = (lo + hi) / 2;
                if (sumaPisosConFactor(mid) <= anchoDisponiblePt) lo = mid;
                else hi = mid;
              }
              factor = lo;
            }

            this.escalarFuenteCelda(n.table.body, factor, PDF_THEME.BODY_SIZE * PX_A_PT);
            ({ necesarios, pisos, sumaNecesaria, sumaPisos } = medir(Math.max(4, paddingCeldaPt * factor)));
          }

          let anchos: number[];
          if (sumaNecesaria <= anchoDisponiblePt) {
            // Alcanza el espacio para dar a cada columna lo que pide — reparto proporcional normal.
            anchos = necesarios.map((necesario) => Math.floor((necesario / sumaNecesaria) * anchoDisponiblePt));
          } else {
            // Hay que achicar: primero se le da a cada columna su piso de palabra completa, y el
            // espacio que sobra (o falta) se reparte proporcional a cuánto pedía cada columna POR
            // ENCIMA de su piso — así una columna angosta ("Estado") no pierde su piso solo porque
            // una columna vecina ancha ("Descripción") pide mucho más.
            const anchoRestante = anchoDisponiblePt - sumaPisos;
            if (anchoRestante >= 0) {
              const excedentes = necesarios.map((necesario, i) => Math.max(0, necesario - pisos[i]));
              const sumaExcedentes = excedentes.reduce((a, b) => a + b, 0);
              anchos =
                sumaExcedentes > 0
                  ? pisos.map((piso, i) => piso + Math.floor((excedentes[i] / sumaExcedentes) * anchoRestante))
                  : pisos.slice();
            } else {
              // Último recurso extremo: ni con la letra ya achicada al mínimo (factor 0.35) caben
              // los pisos — reparto proporcional a los pisos mismos, aceptando alguna palabra
              // apretada en vez de desbordar la página.
              anchos = pisos.map((piso) => Math.floor((piso / sumaPisos) * anchoDisponiblePt));
            }
          }
          n.table.widths = anchos;
        }

        // Centrar la tabla en el ancho REAL de la página — sin esto, la tabla queda pegada al
        // margen izquierdo y todo el espacio de sobra (colchón + sobrecosto por columna que NO se
        // usó) se acumula como un bloque de aire muerto a la derecha, en vez de repartirse parejo
        // en ambos filos. El ancho que en verdad ocupa la tabla al renderizarse es la suma de
        // `widths` MÁS el sobrecosto por columna (ver `SOBRECOSTO_POR_COLUMNA_PT`), no solo la
        // suma de `widths` — si se centra contra la suma cruda, el margen calculado queda corto y
        // la tabla se sigue viendo desviada hacia la izquierda.
        if (n.table.widths) {
          const sumaAnchosFinal = (n.table.widths as number[]).reduce((a, b) => a + b, 0);
          const sumaRenderizadaReal = sumaAnchosFinal + PdfHtmlService.SOBRECOSTO_POR_COLUMNA_PT * numColumnas;
          const sobrante = anchoPaginaCompletoPt - sumaRenderizadaReal;
          if (sobrante > 0) (n as { margin?: number[] }).margin = [Math.floor(sobrante / 2), 0, 0, 0];
        }
      }
      if (n.stack) this.forzarAnchosDeColumnaUniformes(n.stack, anchoPaginaCompletoPt, anchosColumnas);
      if (n.columns) this.forzarAnchosDeColumnaUniformes(n.columns, anchoPaginaCompletoPt, anchosColumnas);
      if (n.table?.body) this.forzarAnchosDeColumnaUniformes(n.table.body, anchoPaginaCompletoPt, anchosColumnas);
    }
  }

  // pdfkit._normalizeColor (el motor de bajo nivel detrás de pdfmake) solo reconoce colores hex
  // ('#rrggbb') o nombres CSS — el formato 'rgb(r, g, b)' que usa getThemeRawColorsPdf() no matchea
  // ninguno de sus casos y devuelve null; fillColor() entonces falla EN SILENCIO y pdfkit deja el
  // último color de relleno que haya quedado activo en el documento (por eso todas las rebanadas
  // salían del mismo azul en vez de sus colores propios). Se normaliza acá para que cualquier
  // llamador pueda seguir pasando 'rgb(...)' (el formato que ya usan los reportes) sin tener que
  // acordarse de esta limitación de pdfkit.
  private rgbStringAHex(color: string): string {
    const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return color;
    const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }

  // Pie chart vectorial dibujado a mano con el tipo `canvas`/`polyline` nativo de pdfmake (sin
  // Chart.js, sin canvas de navegador, sin dependencias nativas) — cada rebanada es un polígono
  // que aproxima el arco con `segmentosPorSlice` puntos entre el centro y el borde. Empieza arriba
  // (-90°, como Chart.js) y avanza en sentido horario. `radio` en puntos PDF; el nodo resultante
  // mide (radio*2, radio*2) — pdfmake calcula el bounding box del canvas a partir del punto más
  // lejano de cada polyline (ver docMeasure.js measureCanvas).
  construirGraficoPieCanvas(datos: { valor: number; color: string }[], radio = 42): any[] {
    const total = datos.reduce((s, d) => s + Math.max(0, d.valor), 0);
    const slices: any[] = [];
    if (total <= 0) return slices;
    const cx = radio, cy = radio;
    let anguloInicio = -Math.PI / 2;
    for (const d of datos) {
      const fraccion = Math.max(0, d.valor) / total;
      if (fraccion <= 0) continue;
      const anguloFin = anguloInicio + fraccion * 2 * Math.PI;
      const pasos = Math.max(2, Math.round(64 * fraccion));
      const puntos: { x: number; y: number }[] = [{ x: cx, y: cy }];
      for (let i = 0; i <= pasos; i++) {
        const a = anguloInicio + ((anguloFin - anguloInicio) * i) / pasos;
        puntos.push({ x: cx + radio * Math.cos(a), y: cy + radio * Math.sin(a) });
      }
      slices.push({ type: 'polyline', points: puntos, closePath: true, color: this.rgbStringAHex(d.color), lineColor: '#ffffff', lineWidth: 1.5 });
      anguloInicio = anguloFin;
    }
    return slices;
  }

  /**
   * Punto de entrada de TODOS los PDF del sistema.
   *
   * No genera nada por sí mismo: pide turno en la cola y recién entonces delega en
   * `construirYEnviarPdf`. Ver el comentario de la cola, arriba, para el porqué.
   */
  async generarPdf(html: string, nombreArchivo: string, res: Response, opciones?: { landscape?: boolean; piePagina?: string; anchosColumnas?: number[]; graficosPorId?: Record<string, any[]> }) {
    if (enCola >= MAX_EN_COLA) {
      this.logger.warn(`Cola de PDF llena (${enCola} en espera): se rechaza "${nombreArchivo}"`);
      throw new ServiceUnavailableException(
        'Hay varios reportes generándose en este momento. Espera unos segundos y vuelve a intentarlo.',
      );
    }

    enCola++;
    const pedidoEn = Date.now();

    const tarea = () => {
      const esperaMs = Date.now() - pedidoEn;
      if (esperaMs > 1000) {
        this.logger.log(`"${nombreArchivo}" esperó ${(esperaMs / 1000).toFixed(1)}s en la cola de PDF`);
      }
      return this.construirYEnviarPdf(html, nombreArchivo, res, opciones);
    };

    // Se engancha al final de la fila. El segundo argumento de .then() es el mismo `tarea`:
    // si el PDF anterior falló, este igual debe correr — un error ajeno no puede saltearle el
    // turno ni dejarlo esperando para siempre.
    const miTurno = turno.then(tarea, tarea);

    // La fila avanza pase lo que pase: se encadena una versión que nunca rechaza, para que un
    // PDF que explota no deje la cola rota para todos los siguientes.
    turno = miTurno.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await miTurno;
    } finally {
      enCola--;
    }
  }

  /** Trabajo real de armar y enviar el PDF. Privado: siempre se entra por `generarPdf`. */
  private async construirYEnviarPdf(html: string, nombreArchivo: string, res: Response, opciones?: { landscape?: boolean; piePagina?: string; anchosColumnas?: number[]; graficosPorId?: Record<string, any[]> }) {
    try {
      if (html.includes('__pdfChartsReady')) {
        this.logger.warn(
          `generarPdf: "${nombreArchivo}" usa gráficos Chart.js que pdfmake no puede renderizar (no ejecuta JS). El PDF se genera sin esos gráficos.`,
        );
      }
      // html-to-pdfmake no tiene ningún caso especial para <script> (solo ignora COLGROUP/COL,
      // ver index.js) — al no ejecutar JS, camina el contenido del script como si fueran nodos
      // de texto normales y lo vuelca literal y visible en el PDF (el bundle entero de Chart.js
      // minificado como texto de la página). juice() ya se encarga de <style>, pero <script>
      // queda intacto en el HTML — hay que sacarlo a mano antes de convertir.
      const htmlSinScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '');

      // juice() inlinea el <style> del reporte (colores, bordes, etc.) a atributos style="",
      // que es lo único que html-to-pdfmake entiende — un <style> con selectores de clase se
      // ignora por completo si no se hace este paso antes.
      const htmlConEstilosInline = this.propagarFondoDeFilaACeldas(juice(htmlSinScripts));

      const ventanaDom = new JSDOM('').window;
      // `customTag`: hook oficial de html-to-pdfmake para devolver un nodo pdfmake propio en vez
      // del que arma por default — se usa para reemplazar cada `<canvas id="...">` (que Chart.js
      // dibujaba en el navegador y que acá siempre llega vacío) por el pie chart vectorial
      // construido en `construirGraficoPieCanvas`, si el reporte mandó datos para ese id.
      const graficosPorId = opciones?.graficosPorId;
      let contenido = htmlToPdfmake(htmlConEstilosInline, {
        window: ventanaDom as unknown as Window,
        customTag: graficosPorId
          ? ({ element, ret }: { element: { nodeName: string; id?: string }; ret: any }) => {
              if (element.nodeName?.toUpperCase() === 'CANVAS' && element.id && graficosPorId[element.id]) {
                return { canvas: graficosPorId[element.id], id: element.id };
              }
              return ret;
            }
          : undefined,
      } as any);
      contenido = this.expandirFlexGrid(contenido as unknown[]) as typeof contenido;
      this.quitarFuentesNoRegistradas(contenido);
      const anchoPagina = opciones?.landscape ? ALTO_A4_PT : ANCHO_A4_PT;
      // `forzarAnchosDeColumnaUniformes` recibe el ancho COMPLETO de la página (no un valor ya
      // recortado) — internamente descuenta el colchón fijo y el sobrecosto por columna que
      // corresponda a cada tabla según su propia cantidad de columnas (ver comentario de
      // `SOBRECOSTO_POR_COLUMNA_PT`), y le da ancho completo real a las tablas de 1 columna
      // (banners de título) sin descontarles nada.
      this.forzarAnchosDeColumnaUniformes(contenido, anchoPagina - MARGEN_PT * 2, opciones?.anchosColumnas);
      this.ajustarTamanoPorCantidadDeFilas(contenido);

      const docDefinition = {
        pageSize: 'A4',
        pageOrientation: opciones?.landscape ? 'landscape' : 'portrait',
        // Margen inferior más alto que el resto: dentro de ese espacio extra es donde pdfmake
        // dibuja el `footer` (paginación) — con el mismo MARGEN_PT que arriba/lados el texto del
        // footer queda pegado o se superpone a la última fila de contenido de la página.
        pageMargins: [MARGEN_PT, MARGEN_PT, MARGEN_PT, MARGEN_PT + 16],
        content: contenido,
        defaultStyle: { font: FUENTE_POR_DEFECTO, fontSize: PDF_THEME.BODY_SIZE },
        // Footer global de TODOS los reportes PDF (paginación + pie opcional por reporte, ej.
        // totales acumulados) — un solo lugar en vez de que cada reporte arme el suyo a mano.
        footer: (currentPage: number, pageCount: number) => ({
          margin: [MARGEN_PT, 6, MARGEN_PT, 0],
          columns: [
            { text: opciones?.piePagina || '', fontSize: PDF_THEME.SMALL_SIZE, color: '#94A3B8' },
            { text: `Página ${currentPage} de ${pageCount}`, fontSize: PDF_THEME.SMALL_SIZE, color: '#94A3B8', alignment: 'right' as const },
          ],
        }),
      };

      // pdfmake 0.3: getBuffer() junta los chunks y cierra el stream internamente
      // (antes: printer.createPdfKitDocument(dd) + escuchar data/end a mano).
      // El cast es necesario porque este docDefinition se arma dinámicamente desde el HTML
      // (anchos, márgenes y footer se calculan en runtime), así que sale con tipos más laxos
      // que los tuplas exactas que exige TDocumentDefinitions — ej. `margin: number[]` donde
      // el tipo pide `[number, number, number, number]`. La forma en runtime sí es correcta.
      const pdfBuffer: Buffer = await pdfMake
        .createPdf(docDefinition as unknown as TDocumentDefinitions)
        .getBuffer();

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=${nombreArchivo}.pdf`,
        'Content-Length': pdfBuffer.length,
      });

      res.end(pdfBuffer);
    } catch (error) {
      this.logger.error('Error generando PDF genérico', (error as Error).stack);
      throw new InternalServerErrorException('Error al generar el documento PDF');
    }
  }
}

// Tema tipográfico único para todo reporte PDF generado con PdfService (HTML + Puppeteer).
// Antes de este archivo, cada módulo escribía su propio <style> inline con sus propios
// valores de font-size/font-family a ojo (ej: viajes.service.ts usaba body:10px/th:9px,
// combustible.service.ts usaba body:9px/th:8px con otra font-family) — resultado
// inconsistente entre reportes que deberían verse como parte del mismo sistema.
//
// Uso: importar PDF_THEME en el service y usar sus valores en el template string del HTML,
// en vez de escribir el número/family directo:
//   body { font-family: ${PDF_THEME.FONT_FAMILY}; font-size: ${PDF_THEME.BODY_SIZE}px; }
//   .header h2 { font-size: ${PDF_THEME.TITLE_SIZE}px; }
//   th { font-size: ${PDF_THEME.TABLE_HEADER_SIZE}px; }
//
// Los colores del reporte NO van aquí — siguen viniendo de EXCEL_THEME/EXCEL_THEME_HEX
// (excel-theme.ts), que ya es el tema de color compartido entre Excel y PDF.
export const PDF_THEME = {
  // Nombre lógico usado en las plantillas HTML (font-family en el <style>). El motor de PDF
  // (pdf.service.ts) no lee este string para elegir la tipografía real — pdfmake solo puede
  // usar fuentes registradas explícitamente por nombre. La fuente real embebida (Roboto) y sus
  // 4 variantes (normal/bold/italic/bolditalic) se registran en pdf.service.ts → FONTS, en
  // libs/common/src/configuracion-reportes/fonts/. Para cambiar la tipografía de TODOS los
  // reportes el día de mañana: reemplazar esos 4 archivos .woff2/.ttf y el nombre en FONTS,
  // un solo lugar, ningún reporte necesita tocarse.
  FONT_FAMILY: "'Helvetica', Arial, sans-serif",
  TITLE_SIZE: 22,        // título principal del reporte (header h2)
  SUBTITLE_SIZE: 11,     // línea de "Generado el / Área..." bajo el título
  META_SIZE: 11,         // datos de cabecera (periodo, emisión, filtros aplicados)
  BODY_SIZE: 12,         // texto general de celdas de tabla
  TABLE_HEADER_SIZE: 12, // texto de <th> (encabezado de columnas) — mismo tamaño que el body,
                         // el contraste con el body viene de font-weight:bold, no de ser más grande
  TOTALS_SIZE: 13,       // fila de totales acumulados
  SMALL_SIZE: 10,        // notas al pie, aclaraciones, celdas con texto largo
} as const;

// Tamaño de tabla (cuerpo + encabezado + totales) según cantidad de filas de datos.
// Los tamaños de PDF_THEME de arriba están pensados para un reporte corto (pocas filas,
// letra grande y legible) — un listado de 40+ filas con ese mismo tamaño no entra en la
// página sin verse apretado o cortado. En vez de que cada service invente su propia escala,
// se consulta esta función UNA vez con `data.length` y se usa el resultado en el <style>
// del HTML, igual para todo reporte tabular (préstamos, maestros, lo que sea).
//
// Uso: const t = tamanoTablaPorFilas(data.length);
//      th { font-size: ${t.headerSize}px; } td { font-size: ${t.bodySize}px; }
export function tamanoTablaPorFilas(cantidadFilas: number): {
  bodySize: number;
  headerSize: number;
  totalsSize: number;
} {
  if (cantidadFilas <= 10)  return { bodySize: 11, headerSize: 11, totalsSize: 12 };
  if (cantidadFilas <= 25)  return { bodySize: 9,  headerSize: 9,  totalsSize: 10 };
  if (cantidadFilas <= 50)  return { bodySize: 8,  headerSize: 8,  totalsSize: 9  };
  return                           { bodySize: 7,  headerSize: 7,  totalsSize: 8  };
}

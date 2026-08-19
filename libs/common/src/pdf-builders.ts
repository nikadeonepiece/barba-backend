import type { Content, CustomTableLayout } from 'pdfmake/interfaces';

// Bloques reutilizables para armar los PDF de negocio (cotización, guía de remisión, etc.)
// con pdfmake — reemplaza el enfoque anterior de renderizar HTML/CSS con un navegador
// headless (Chromium), que en hosting compartido chocaba con límites de procesos/hilos
// del sistema operativo. pdfmake genera el PDF en JS puro, sin binarios ni subprocesos.

export function pdfLayoutBordeado(colorBorde: string): CustomTableLayout {
  return {
    hLineWidth: () => 1,
    vLineWidth: () => 1,
    hLineColor: () => colorBorde,
    vLineColor: () => colorBorde,
    paddingLeft: () => 10,
    paddingRight: () => 10,
    paddingTop: () => 8,
    paddingBottom: () => 8,
  };
}

/** Encabezado del documento: nombre de la empresa a la izquierda, tag/número/fecha a la derecha. */
export function pdfEncabezado(opts: {
  empresaNombre: string;
  empresaSub: string;
  tag: string;
  numero: string;
  fecha: string;
  colorPrimary: string;
  colorBorde: string;
}): Content[] {
  return [
    {
      columns: [
        {
          width: '*',
          stack: [
            { text: opts.empresaNombre, fontSize: 20, bold: true },
            { text: opts.empresaSub, fontSize: 10, color: '#333333', margin: [0, 4, 0, 0] },
          ],
        },
        {
          width: 'auto',
          alignment: 'right',
          stack: [
            { text: opts.tag.toUpperCase(), fontSize: 9, bold: true, color: opts.colorPrimary },
            { text: opts.numero, fontSize: 22, bold: true, margin: [0, 2, 0, 0] },
            { text: opts.fecha, fontSize: 10, color: '#333333', margin: [0, 4, 0, 0] },
          ],
        },
      ],
    },
    {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: opts.colorBorde }],
      margin: [0, 14, 0, 20],
    },
  ];
}

/** Caja de datos clave (cliente, fecha, estado, etc.) en columnas con separadores. */
export function pdfInfoBox(
  items: Array<{ label: string; valor: string; valorSub?: string; badgeColor?: string }>,
  colorBorde: string,
): Content {
  const widths = items.map(() => '*' as const);
  const fila = items.map((item, i) => {
    const stack: Content[] = [
      { text: item.label.toUpperCase(), fontSize: 8, bold: true, color: '#333333' },
      item.badgeColor
        ? { text: item.valor, fontSize: 10, bold: true, color: item.badgeColor, margin: [0, 4, 0, 0] }
        : { text: item.valor, fontSize: 11, bold: true, margin: [0, 4, 0, 0] },
    ];
    if (item.valorSub) {
      stack.push({ text: item.valorSub, fontSize: 9, color: '#333333', margin: [0, 2, 0, 0] });
    }
    return {
      stack,
      border: [i > 0, true, i === items.length - 1, true] as [boolean, boolean, boolean, boolean],
    };
  });

  return {
    table: { widths, body: [fila] },
    layout: pdfLayoutBordeado(colorBorde),
    margin: [0, 0, 0, 20],
  };
}

/** Caja de totales alineada a la derecha (subtotal, IGV, total). */
export function pdfTotalsBox(
  filas: Array<{ label: string; monto: string; destacado?: boolean }>,
  colorBorde: string,
): Content {
  return {
    columns: [
      { width: '*', text: '' },
      {
        width: 220,
        table: {
          widths: ['*'],
          body: filas.map((f) => [
            {
              columns: [
                { text: f.label, fontSize: f.destacado ? 10 : 9.5, bold: true, color: f.destacado ? '#111111' : '#333333' },
                { text: f.monto, fontSize: f.destacado ? 15 : 11, bold: true, alignment: 'right' },
              ],
              border: [false, false, false, false] as [boolean, boolean, boolean, boolean],
            },
          ]),
        },
        layout: pdfLayoutBordeado(colorBorde),
      },
    ],
  };
}

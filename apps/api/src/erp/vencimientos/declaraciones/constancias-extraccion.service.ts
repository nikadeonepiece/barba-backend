import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { PDFParse } from 'pdf-parse';

// ⚠️ NUNCA dentro de `uploads/` — esa carpeta se sirve estática y SIN login desde
// main.ts, y una constancia es el documento tributario de un cliente del estudio.
// Mismo criterio que los archivos SIRE (sire.service.ts). Se sirven por el endpoint
// con guard `GET /vencimientos/constancias/archivo`.
export const CARPETA_CONSTANCIAS = resolve(process.cwd(), 'storage-privado', 'constancias');

export interface TributoExtraido {
  concepto: string;
  totalDeuda: string;
  montoPago: string;
}

export interface ConstanciaExtraida {
  periodo: string | null;
  ruc: string | null;
  razonSocial: string | null;
  tipoDeclaracion: string | null;
  numeroFormulario: string | null;
  fechaPresentacion: string | null;
  tributos: TributoExtraido[];
  totalPagar: { totalDeuda: string; montoPago: string } | null;
  advertencia: string | null;
}

/**
 * Extracción SIN IA de constancias SUNAT (PDF con texto seleccionable, no escaneado).
 * Usa `pdf-parse` v2: `getText()` para los campos de cabecera (Período, RUC, etc. — el
 * generador de SUNAT los rinde como un bloque de etiquetas seguido de un bloque de
 * valores en el mismo orden, así que se emparejan por posición) y `getTable()` para la
 * tabla "Detalle de Tributos" (detección real de líneas del PDF, no regex sobre texto
 * corrido). No guarda nada en BD — es una consulta on-demand desde el frontend.
 */
@Injectable()
export class ConstanciasExtraccionService {
  async extraer(rutaRelativa: string): Promise<ConstanciaExtraida> {
    const rutaAbsoluta = this.resolverRutaSegura(rutaRelativa);

    const buffer = readFileSync(rutaAbsoluta);
    const parser = new PDFParse({ data: buffer });

    try {
      // Secuencial a propósito: `PDFParse` comparte estado interno del documento entre
      // llamadas — correr getText()/getTable() en paralelo (Promise.all) devuelve
      // resultados corruptos/vacíos de forma silenciosa (confirmado probando contra
      // constancias reales), no lanza ningún error.
      const textoResult = await parser.getText();
      const tablaResult = await parser.getTable().catch(() => null);

      const campos = this.extraerCamposCabecera(textoResult.text);
      const { tributos, totalPagar } = this.extraerTablaTributos(tablaResult);

      const advertencia = !textoResult.text?.trim() || textoResult.text.trim().length < 20
        ? 'No se pudo leer texto de este PDF — probablemente es un documento escaneado (imagen), no generado digitalmente.'
        : null;

      return {
        periodo: this.buscarCampo(campos, 'período') || this.buscarCampo(campos, 'periodo'),
        ruc: this.buscarCampo(campos, 'ruc'),
        razonSocial: this.buscarCampo(campos, 'nombre o razón social') || this.buscarCampo(campos, 'razón social'),
        tipoDeclaracion: this.buscarCampo(campos, 'tipo de declaración'),
        numeroFormulario: this.buscarCampo(campos, 'número de formulario'),
        fechaPresentacion: this.buscarCampo(campos, 'fecha de presentación'),
        tributos,
        totalPagar,
        advertencia,
      };
    } finally {
      await parser.destroy();
    }
  }

  // Evita path traversal: la ruta que manda el frontend viene de datos ya guardados en
  // BD, pero igual se valida por si alguien manipula el body a mano contra el endpoint.
  // Se queda solo con el nombre del archivo (último segmento), así sirve tanto para las
  // rutas nuevas (`/constancias/x.pdf`) como para las que quedaron en BD del esquema
  // viejo (`/uploads/constancias/x.pdf`) — en ambos casos el PDF vive hoy en
  // `storage-privado/constancias`.
  resolverRutaSegura(rutaRelativa: string): string {
    const nombreArchivo = String(rutaRelativa || '').split(/[\\/]/).pop()?.trim() || '';
    if (!nombreArchivo || nombreArchivo.includes('..')) {
      throw new BadRequestException('Ruta de archivo inválida');
    }

    const rutaAbsoluta = resolve(CARPETA_CONSTANCIAS, nombreArchivo);
    if (!rutaAbsoluta.startsWith(CARPETA_CONSTANCIAS)) {
      throw new BadRequestException('Ruta de archivo inválida');
    }
    if (!existsSync(rutaAbsoluta)) {
      throw new NotFoundException('El archivo de la constancia ya no existe en el servidor');
    }
    if (!rutaAbsoluta.toLowerCase().endsWith('.pdf')) {
      throw new BadRequestException('El archivo no es un PDF');
    }
    return rutaAbsoluta;
  }

  // Las constancias SUNAT (formularios 0601, 0621, etc.) generan el bloque de campos
  // como N líneas "Etiqueta :" seguidas de N líneas de valor, en el mismo orden. Dentro
  // de ese bloque hay además encabezados de sección tipo "Datos de la Declaración
  // (Laboral):" (terminan en ":" pegado, sin espacio antes) intercalados — cuentan para
  // no cortar la racha de detección, pero NO son campos reales y se filtran antes de
  // emparejar posicionalmente con las líneas de valor que vienen justo después.
  private extraerCamposCabecera(texto: string): Record<string, string> {
    const lineas = texto.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

    let inicio = -1;
    let fin = -1;
    for (let i = 0; i < lineas.length; i++) {
      if (/:$/.test(lineas[i])) {
        if (inicio === -1) inicio = i;
        fin = i;
      } else if (inicio !== -1) {
        break;
      }
    }
    if (inicio === -1) return {};

    const bloque = lineas.slice(inicio, fin + 1);
    const etiquetas = bloque.filter((l) => /\s:$/.test(l)).map((l) => l.replace(/\s*:$/, '').trim().toLowerCase());
    const valores = lineas.slice(fin + 1, fin + 1 + etiquetas.length);

    const campos: Record<string, string> = {};
    etiquetas.forEach((etiqueta, i) => {
      if (valores[i]) campos[etiqueta] = valores[i];
    });
    return campos;
  }

  private buscarCampo(campos: Record<string, string>, clave: string): string | null {
    return campos[clave.toLowerCase()] ?? null;
  }

  // La tabla "Detalle de Tributos" es siempre la primera tabla con encabezado
  // Tributos/Total Deuda/Monto Pago; su última fila es el total.
  private extraerTablaTributos(tablaResult: any): { tributos: TributoExtraido[]; totalPagar: { totalDeuda: string; montoPago: string } | null } {
    const tablas: string[][][] = tablaResult?.pages?.[0]?.tables ?? [];
    const tablaTributos = tablas.find((t) => t[0]?.[0]?.toLowerCase().includes('tributo'));
    if (!tablaTributos || tablaTributos.length < 2) {
      return { tributos: [], totalPagar: null };
    }

    const filas = tablaTributos.slice(1); // sin encabezado
    const filaTotal = filas.find((f) => f[0]?.toLowerCase().includes('total a pagar'));
    const filasTributo = filas.filter((f) => !f[0]?.toLowerCase().includes('total a pagar'));

    return {
      tributos: filasTributo.map((f) => ({
        concepto: f[0] ?? '',
        totalDeuda: f[1] ?? '',
        montoPago: f[2] ?? '',
      })),
      totalPagar: filaTotal ? { totalDeuda: filaTotal[1] ?? '', montoPago: filaTotal[2] ?? '' } : null,
    };
  }
}

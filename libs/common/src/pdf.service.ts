import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { Response } from 'express';
// pdfmake exporta una instancia de clase (sus métodos viven en el prototipo, no como
// propiedades propias) — `import * as pdfMake` copia solo propiedades propias y pierde
// setFonts/createPdf al empaquetar con webpack. `import ... = require(...)` toma la
// referencia real sin ese "copiado".
import pdfMake = require('pdfmake');
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

// Fuentes estándar del PDF (Helvetica) — no son archivos .ttf embebidos, son una de las
// 14 fuentes base que todo lector de PDF ya trae incorporadas. Por eso pdfmake genera el
// documento en JS puro, sin lanzar ningún binario externo (a diferencia del Chromium que
// usábamos antes): corre igual en Windows local que en hosting compartido, sin depender
// de límites de procesos/hilos del sistema operativo.
const FUENTES_ESTANDAR = require('pdfmake/standard-fonts/Helvetica');
pdfMake.setFonts(FUENTES_ESTANDAR);

// Los nombres de las 14 fuentes base del PDF ("Helvetica-Bold", etc.) pasan por el mismo
// validador de "acceso a archivo local" que usaría una ruta real — sin autorizarlos
// explícitamente aquí, pdfmake los rechaza y ni siquiera puede escribir texto en negrita.
const NOMBRES_FUENTES_PERMITIDAS = new Set(
  Object.values(FUENTES_ESTANDAR).flatMap((variantes: any) => Object.values(variantes)),
);

// Nuestros documentos (cotización, guía de remisión) nunca referencian imágenes por URL
// ni por ruta de archivo local — solo texto, tablas y las fuentes estándar de arriba —
// así que se deniega cualquier otro acceso explícitamente.
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy((path: string) => NOMBRES_FUENTES_PERMITIDAS.has(path));

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  async generarPdf(docDefinition: TDocumentDefinitions, nombreArchivo: string, res: Response) {
    try {
      const pdfBuffer = await pdfMake.createPdf(docDefinition).getBuffer();

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

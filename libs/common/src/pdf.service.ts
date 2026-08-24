import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { Response } from 'express';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
// El registro de fuentes (Helvetica estándar + Roboto embebida) y las políticas de acceso
// viven en un solo lugar: pdfmake 0.3 es un singleton de módulo, así que si cada servicio
// llamara a setFonts()/setLocalAccessPolicy() por su cuenta, el último en cargar dejaría al
// otro sin fuentes. Ver el comentario de cabecera de pdf-fuentes.ts.
import { pdfMake, FUENTE_ESTANDAR } from './pdf-fuentes';

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  async generarPdf(docDefinition: TDocumentDefinitions, nombreArchivo: string, res: Response) {
    try {
      // 'Helvetica' explícita, no por omisión: desde que también se registra Roboto (para los
      // reportes HTML de PdfHtmlService), pdfmake toma Roboto como fuente por defecto y estos
      // documentos cambiarían de tipografía en silencio. Solo se rellena si el reporte no
      // eligió una, así que un docDefinition que ya define su font manda igual.
      const conFuente: TDocumentDefinitions = {
        ...docDefinition,
        defaultStyle: { font: FUENTE_ESTANDAR, ...docDefinition.defaultStyle },
      };
      const pdfBuffer = await pdfMake.createPdf(conFuente).getBuffer();

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

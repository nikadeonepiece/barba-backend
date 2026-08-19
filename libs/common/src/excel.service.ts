import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';

export interface ExcelColumn {
  header: string;
  key: string;
  width?: number;
}

@Injectable()
export class ExcelService {
  async generarExcel(
    columnas: ExcelColumn[], 
    data: any[], 
    nombreArchivo: string, 
    nombreHoja: string, 
    res: Response
  ) {
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(nombreHoja);

      // 1. Asignar columnas
      worksheet.columns = columnas;

      // 2. Estilo global a la cabecera (Azul Montero)
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0070C0' } };
      worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

      // 3. Insertar data
      data.forEach((item) => {
        worksheet.addRow(item);
      });

      // 4. Configurar respuesta HTTP
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=${nombreArchivo}.xlsx`);

      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      console.error('Error generando Excel genérico:', error);
      throw new InternalServerErrorException('Error al generar el documento Excel');
    }
  }
}
import { Module } from '@nestjs/common';
import { CommonService } from './common.service';
import { ExcelService } from './excel.service';
import { PdfService } from './pdf.service';
import { PdfHtmlService } from './pdf-html.service';

@Module({
  providers: [CommonService, PdfService, PdfHtmlService, ExcelService],
  exports: [CommonService, PdfService, PdfHtmlService, ExcelService],
})
export class CommonModule {}
import { Module } from '@nestjs/common';
import { CommonService } from './common.service';
import { ExcelService } from './excel.service';
import { PdfService } from './pdf.service';

@Module({
  providers: [CommonService, PdfService, ExcelService],
  exports: [CommonService, PdfService, ExcelService],
})
export class CommonModule {}
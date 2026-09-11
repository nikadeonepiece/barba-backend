import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { CentrosCostoConfigController } from './centros-costo-config.controller';
import { CentrosCostoConfigService } from './centros-costo-config.service';

/**
 * `CommonModule` por `ExcelService` y `PdfHtmlService` (los dos export de la pantalla).
 * `AuditoriaService` no se importa: `AuditoriaModule` es `@Global()`.
 */
@Module({
  imports: [CommonModule],
  controllers: [CentrosCostoConfigController],
  providers: [CentrosCostoConfigService],
  exports: [CentrosCostoConfigService],
})
export class CentrosCostoConfigModule {}

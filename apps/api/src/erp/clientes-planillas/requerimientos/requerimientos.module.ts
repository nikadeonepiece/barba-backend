import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { RequerimientosController } from './requerimientos.controller';
import { RequerimientosService } from './requerimientos.service';
import { RequerimientosArchivoService } from './requerimientos-archivo.service';

/**
 * `CommonModule` por `ExcelService` y `PdfHtmlService`. `AuditoriaService` no se
 * importa: `AuditoriaModule` es `@Global()`.
 *
 * Exporta `RequerimientosArchivoService` porque la pantalla de APROBACIÓN necesita
 * servir el mismo comprobante (quien aprueba tiene que poder mirar la proforma).
 * Duplicar ahí la resolución de rutas sería duplicar el control anti-traversal, y el
 * día que se corrija en uno el otro queda abierto — mismo criterio que
 * `CajasClienteModule` con `CajasArchivoService`.
 */
@Module({
  imports: [CommonModule],
  controllers: [RequerimientosController],
  providers: [RequerimientosService, RequerimientosArchivoService],
  exports: [RequerimientosService, RequerimientosArchivoService],
})
export class RequerimientosModule {}

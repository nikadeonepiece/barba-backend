import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { CajasController } from './cajas.controller';
import { CajasService } from './cajas.service';
import { CajasArchivoService } from './cajas-archivo.service';

/**
 * `CommonModule` provee `ExcelService`, `PdfService` y `AuditoriaService`: sin ese
 * import la inyección del service no resuelve.
 */
@Module({
  imports: [CommonModule],
  controllers: [CajasController],
  providers: [CajasService, CajasArchivoService],
  // `CajasArchivoService` se exporta para el PORTAL CLIENTE (`clientes-planillas/cajas`),
  // que necesita mandar y borrar los mismos comprobantes. Es lo ÚNICO que ese módulo
  // reusa de acá: sus consultas son propias y acotadas por empresa.
  exports: [CajasService, CajasArchivoService],
})
export class CajasModule {}

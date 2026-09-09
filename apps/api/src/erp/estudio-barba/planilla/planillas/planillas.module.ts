import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { PlanillasController } from './planillas.controller';
import { PlanillasService } from './planillas.service';
import { MotorCalculoService } from './motor-calculo.service';
import { BoletaPdfService } from './boleta-pdf.service';
import { BoletasFirmadasArchivoService } from './boletas-firmadas-archivo.service';

/**
 * `BoletaPdfService` se exporta porque el portal cliente (`erp/cliente/planillas/`)
 * imprime la MISMA boleta que la intranet. Se comparte el maquetado, no las consultas:
 * el portal arma los datos con sus propias queries acotadas por empresa.
 *
 * `BoletasFirmadasArchivoService` se exporta por el mismo motivo que
 * `ContratosArchivoService`: el día que el portal cliente suba o descargue la boleta
 * firmada, reusa esta lógica de disco en vez de copiar el control anti-traversal.
 */
@Module({
  imports: [CommonModule],
  controllers: [PlanillasController],
  providers: [PlanillasService, MotorCalculoService, BoletaPdfService, BoletasFirmadasArchivoService],
  exports: [PlanillasService, MotorCalculoService, BoletaPdfService, BoletasFirmadasArchivoService],
})
export class PlanillasModule {}

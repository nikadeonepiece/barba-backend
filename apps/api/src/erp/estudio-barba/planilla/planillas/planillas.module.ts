import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { PlanillasController } from './planillas.controller';
import { PlanillasService } from './planillas.service';
import { MotorCalculoService } from './motor-calculo.service';
import { BoletaPdfService } from './boleta-pdf.service';

/**
 * `BoletaPdfService` se exporta porque el portal cliente (`erp/cliente/planillas/`)
 * imprime la MISMA boleta que la intranet. Se comparte el maquetado, no las consultas:
 * el portal arma los datos con sus propias queries acotadas por empresa.
 */
@Module({
  imports: [CommonModule],
  controllers: [PlanillasController],
  providers: [PlanillasService, MotorCalculoService, BoletaPdfService],
  exports: [PlanillasService, MotorCalculoService, BoletaPdfService],
})
export class PlanillasModule {}

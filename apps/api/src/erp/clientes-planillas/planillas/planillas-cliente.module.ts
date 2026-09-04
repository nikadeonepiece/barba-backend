import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { PlanillasModule } from '../../estudio-barba/planilla/planillas/planillas.module';
import { PlanillasClienteController } from './planillas-cliente.controller';
import { PlanillasClienteService } from './planillas-cliente.service';

/**
 * Importa `PlanillasModule` solo por `BoletaPdfService`: el maquetado de la boleta se
 * comparte con la intranet para que el estudio y el cliente miren el mismo documento.
 * Las CONSULTAS son propias y acotadas por empresa — `PlanillasService` no filtra por
 * ninguna y usarlo desde acá sería el agujero que este módulo existe para evitar.
 */
@Module({
  imports: [CommonModule, PlanillasModule],
  controllers: [PlanillasClienteController],
  providers: [PlanillasClienteService],
  exports: [PlanillasClienteService],
})
export class PlanillasClienteModule {}

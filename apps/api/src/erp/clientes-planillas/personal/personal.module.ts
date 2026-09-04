import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { ContratosModule } from '../../estudio-barba/planilla/contratos/contratos.module';
import { PersonalClienteController } from './personal.controller';
import { PersonalClienteService } from './personal.service';

/**
 * Importa `ContratosModule` solo por `ContratosArchivoService` (validar la ruta y
 * mandar el PDF por stream). Las CONSULTAS de contratos son propias y acotadas por
 * empresa: reusar `ContratosService`, que no filtra por ninguna, sería el agujero que
 * este módulo existe para evitar.
 */
@Module({
  imports: [CommonModule, ContratosModule],
  controllers: [PersonalClienteController],
  providers: [PersonalClienteService],
  exports: [PersonalClienteService],
})
export class PersonalClienteModule {}

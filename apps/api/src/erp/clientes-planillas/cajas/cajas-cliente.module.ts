import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { CajasModule } from '../../estudio-barba/tesoreria/cajas/cajas.module';
import { CajasClienteController } from './cajas-cliente.controller';
import { CajasClienteService } from './cajas-cliente.service';

/**
 * Importa `CajasModule` SOLO por `CajasArchivoService` (validar la ruta del comprobante,
 * mandarlo por stream y borrar el huérfano) y por la config de multer, que decide dónde
 * caen los archivos. Duplicarla acá sería duplicar el control anti-traversal, y el día
 * que se corrija en uno el otro queda abierto.
 *
 * Las CONSULTAS son propias y acotadas por empresa: reusar `CajasService`, que no filtra
 * por ninguna, sería justo el agujero que este módulo existe para evitar. Mismo criterio
 * que `PersonalClienteModule` con `ContratosModule`.
 */
@Module({
  imports: [CommonModule, CajasModule],
  controllers: [CajasClienteController],
  providers: [CajasClienteService],
  exports: [CajasClienteService],
})
export class CajasClienteModule {}

import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { RequerimientosModule } from '../../../clientes-planillas/requerimientos/requerimientos.module';
import { MovimientosController } from './movimientos.controller';
import { MovimientosService } from './movimientos.service';

/**
 * `RequerimientosModule` se importa SOLO por `RequerimientosArchivoService`: es el que
 * sabe dónde caen los comprobantes privados, cómo servirlos por stream y cómo impedir
 * que una ruta se escape de su carpeta. Duplicar acá esa resolución sería duplicar el
 * control anti-traversal, y el día que se corrija en uno el otro queda abierto — mismo
 * criterio que `CajasClienteModule` con `CajasArchivoService`.
 *
 * Las consultas son propias: nada de este módulo pasa por el service de requerimientos.
 */
@Module({
  imports: [CommonModule, RequerimientosModule],
  controllers: [MovimientosController],
  providers: [MovimientosService],
  exports: [MovimientosService],
})
export class MovimientosModule {}

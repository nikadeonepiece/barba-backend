import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { RequerimientosModule } from '../requerimientos/requerimientos.module';
import { AprobacionRequerimientosController } from './aprobacion-requerimientos.controller';
import { AprobacionRequerimientosService } from './aprobacion-requerimientos.service';

/**
 * Importa `RequerimientosModule` por `RequerimientosService`, y solo para LEER: el
 * listado y el detalle son exactamente la misma consulta, y dos versiones de "qué dice
 * este requerimiento" terminan mostrando distinto en cada pantalla.
 *
 * La escritura es propia y acotada: acá se aprueba, se rechaza y se revierte. El
 * `update()` de allá no se usa nunca desde este módulo.
 */
@Module({
  imports: [CommonModule, RequerimientosModule],
  controllers: [AprobacionRequerimientosController],
  providers: [AprobacionRequerimientosService],
  exports: [AprobacionRequerimientosService],
})
export class AprobacionRequerimientosModule {}

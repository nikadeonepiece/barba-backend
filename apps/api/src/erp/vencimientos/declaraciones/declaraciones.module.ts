import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { DeclaracionesService } from './declaraciones.service';
import { DeclaracionesController } from './declaraciones.controller';
import { ConstanciasController } from './constancias.controller';
import { ConstanciasExtraccionService } from './constancias-extraccion.service';

@Module({
  imports: [CommonModule],
  controllers: [DeclaracionesController, ConstanciasController],
  providers: [DeclaracionesService, ConstanciasExtraccionService],
  exports: [DeclaracionesService],
})
export class DeclaracionesModule {}

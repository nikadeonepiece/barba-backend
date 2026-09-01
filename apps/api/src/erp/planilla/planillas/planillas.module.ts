import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { PlanillasController } from './planillas.controller';
import { PlanillasService } from './planillas.service';
import { MotorCalculoService } from './motor-calculo.service';

@Module({
  imports: [CommonModule],
  controllers: [PlanillasController],
  providers: [PlanillasService, MotorCalculoService],
  exports: [PlanillasService, MotorCalculoService],
})
export class PlanillasModule {}

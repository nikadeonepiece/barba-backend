import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { BeneficiosController } from './beneficios.controller';
import { BeneficiosService } from './beneficios.service';
import { MotorBeneficiosService } from './motor-beneficios.service';

@Module({
  imports: [CommonModule],
  controllers: [BeneficiosController],
  providers: [BeneficiosService, MotorBeneficiosService],
  exports: [BeneficiosService, MotorBeneficiosService],
})
export class BeneficiosModule {}

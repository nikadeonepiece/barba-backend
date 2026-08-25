import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { BuzonSunatController } from './buzon-sunat.controller';
import { BuzonSunatService } from './buzon-sunat.service';
import { SunatBuzonClient } from './sunat-buzon.client';
import { CredencialesCryptoService } from '@app/security';

@Module({
  imports: [CommonModule],
  controllers: [BuzonSunatController],
  providers: [BuzonSunatService, SunatBuzonClient, CredencialesCryptoService],
  exports: [BuzonSunatService],
})
export class BuzonSunatModule {}

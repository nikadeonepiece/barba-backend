import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { SunafilController } from './sunafil.controller';
import { SunafilService } from './sunafil.service';
import { SunafilCasillaClient } from './sunafil-casilla.client';
import { CredencialesCryptoService } from '@app/security';

@Module({
  imports: [CommonModule],
  controllers: [SunafilController],
  providers: [SunafilService, SunafilCasillaClient, CredencialesCryptoService],
  exports: [SunafilService],
})
export class SunafilModule {}

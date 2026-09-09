import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { PleController } from './ple.controller';
import { PleService } from './ple.service';
import { SunatPleClient } from './sunat-ple.client';
import { CredencialesCryptoService } from '@app/security';

@Module({
  imports: [CommonModule],
  controllers: [PleController],
  providers: [PleService, SunatPleClient, CredencialesCryptoService],
  exports: [PleService],
})
export class PleModule {}

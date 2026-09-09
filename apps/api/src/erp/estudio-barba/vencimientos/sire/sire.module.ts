import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { SireController } from './sire.controller';
import { SireService } from './sire.service';
import { CredencialesCryptoService } from '@app/security';
import { SunatCpeClient } from './sunat-cpe.client';

@Module({
  imports: [CommonModule],
  controllers: [SireController],
  providers: [SireService, CredencialesCryptoService, SunatCpeClient],
  exports: [SireService],
})
export class SireModule {}

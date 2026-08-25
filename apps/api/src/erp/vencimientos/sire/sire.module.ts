import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { SireController } from './sire.controller';
import { SireService } from './sire.service';
import { CredencialesCryptoService } from '@app/security';

@Module({
  imports: [CommonModule],
  controllers: [SireController],
  providers: [SireService, CredencialesCryptoService],
  exports: [SireService],
})
export class SireModule {}

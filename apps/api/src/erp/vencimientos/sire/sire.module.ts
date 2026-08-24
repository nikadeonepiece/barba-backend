import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { SireController } from './sire.controller';
import { SireService } from './sire.service';
import { CredencialesCryptoService } from '../../comun/credenciales-crypto.service';

@Module({
  imports: [CommonModule],
  controllers: [SireController],
  providers: [SireService, CredencialesCryptoService],
  exports: [SireService],
})
export class SireModule {}

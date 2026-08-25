import { Module } from '@nestjs/common';
import { EmpresasService } from './empresas.service';
import { EmpresasController } from './empresas.controller';
import { CredencialesCryptoService } from '@app/security';
import { SunatLoginClient } from './sunat-login.client';

@Module({
  controllers: [EmpresasController],
  providers: [EmpresasService, CredencialesCryptoService, SunatLoginClient],
  exports: [EmpresasService, CredencialesCryptoService],
})
export class EmpresasModule {}

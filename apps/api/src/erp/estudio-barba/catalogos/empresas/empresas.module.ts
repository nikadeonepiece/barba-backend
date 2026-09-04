import { Module } from '@nestjs/common';
import { EmpresasService } from './empresas.service';
import { EmpresasController } from './empresas.controller';
import { CredencialesCryptoService } from '@app/security';
import { SunatLoginClient } from './sunat-login.client';
import { EmpresaLogoService } from './empresa-logo.service';

@Module({
  controllers: [EmpresasController],
  providers: [EmpresasService, CredencialesCryptoService, SunatLoginClient, EmpresaLogoService],
  exports: [EmpresasService, CredencialesCryptoService],
})
export class EmpresasModule {}

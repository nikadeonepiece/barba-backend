import { Module } from '@nestjs/common';
import { SunatSyncService } from './sunat-sync.service';
import { SunatSyncController } from './sunat-sync.controller';
import { SunatSireClient } from './sunat-sire.client';
import { SunatScrapingClient } from './sunat-scraping.client';
import { CredencialesCryptoService } from '../credenciales-crypto.service';

@Module({
  controllers: [SunatSyncController],
  providers: [SunatSyncService, SunatSireClient, SunatScrapingClient, CredencialesCryptoService],
  exports: [SunatSyncService],
})
export class Fase2Module {}

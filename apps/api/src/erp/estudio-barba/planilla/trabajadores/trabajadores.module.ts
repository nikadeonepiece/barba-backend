import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { TrabajadoresController } from './trabajadores.controller';
import { TrabajadoresService } from './trabajadores.service';
import { SunatTregistroClient } from './sunat-tregistro.client';
import { SunatTregistroScrapingClient } from './sunat-tregistro-scraping.client';
import { ImportacionTrabajadoresController } from './importacion.controller';
import { ImportacionTrabajadoresService } from './importacion.service';
import { CredencialesCryptoService } from '@app/security';

@Module({
  imports: [CommonModule],
  controllers: [TrabajadoresController, ImportacionTrabajadoresController],
  providers: [TrabajadoresService, SunatTregistroClient, SunatTregistroScrapingClient, CredencialesCryptoService, ImportacionTrabajadoresService],
  exports: [TrabajadoresService],
})
export class TrabajadoresModule {}

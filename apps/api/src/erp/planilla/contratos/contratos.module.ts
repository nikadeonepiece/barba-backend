import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { ContratosController } from './contratos.controller';
import { ContratosService } from './contratos.service';
import { ContratosArchivoService } from './contratos-archivo.service';

/**
 * `ContratosArchivoService` se EXPORTA porque el portal cliente
 * (`erp/cliente/personal/`) lo necesita para servir el PDF: la lógica anti-traversal y
 * el streaming viven en un solo lugar. Lo que NO se comparte es `ContratosService`,
 * cuyas consultas no filtran por empresa — el portal tiene las suyas, acotadas.
 */
@Module({
  imports: [CommonModule],
  controllers: [ContratosController],
  providers: [ContratosService, ContratosArchivoService],
  exports: [ContratosService, ContratosArchivoService],
})
export class ContratosModule {}

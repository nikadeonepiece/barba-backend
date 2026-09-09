import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { SireClienteController } from './sire-cliente.controller';
import { SireClienteService } from './sire-cliente.service';

/**
 * NO importa `SireModule`. El único código que comparte con el módulo del estudio es
 * `parsearArchivoSire`, una función pura que se importa directo del util — traer el
 * módulo entero metería `SireService` (con `generarTicket`, `traerArchivo` y las
 * credenciales SOL descifradas) al alcance del portal sin necesidad.
 */
@Module({
  imports: [CommonModule],
  controllers: [SireClienteController],
  providers: [SireClienteService],
  exports: [SireClienteService],
})
export class SireClienteModule {}

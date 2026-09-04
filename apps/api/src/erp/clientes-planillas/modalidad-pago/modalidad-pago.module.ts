import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { ModalidadPagoClienteController } from './modalidad-pago.controller';
import { ModalidadPagoClienteService } from './modalidad-pago.service';

/** `CommonModule` por `AuditoriaService`: acá se escribe sobre el padrón. */
@Module({
  imports: [CommonModule],
  controllers: [ModalidadPagoClienteController],
  providers: [ModalidadPagoClienteService],
  exports: [ModalidadPagoClienteService],
})
export class ModalidadPagoClienteModule {}

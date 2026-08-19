
import { Module, Global } from '@nestjs/common';
import { AuditoriaService } from './auditoria.service';


@Global() // <-- ¡Importante! Hace que la auditoría esté disponible en todo el proyecto
@Module({
  providers: [AuditoriaService],
  exports: [AuditoriaService]
})
export class AuditoriaModule {}
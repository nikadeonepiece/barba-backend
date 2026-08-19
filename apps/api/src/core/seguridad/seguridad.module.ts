import { Module } from '@nestjs/common';
import { SeguridadController } from './seguridad.controller';
import { SeguridadService } from './seguridad.service';

// El rate limit ya lo cubre el SecurityModule global (ThrottlerModule + APP_GUARD
// registrado una sola vez en el módulo raíz de la API) — un módulo hoja no debe
// registrar su propio ThrottlerModule/APP_GUARD, pisa/duplica el guard global.
@Module({
  controllers: [SeguridadController],
  providers: [SeguridadService],
})
export class SeguridadModule {}
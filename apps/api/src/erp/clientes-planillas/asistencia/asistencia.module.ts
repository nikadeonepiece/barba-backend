import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { AsistenciaClienteController } from './asistencia.controller';
import { AsistenciaClienteService } from './asistencia.service';

/**
 * `CommonModule` es lo único que importa, y es por `AuditoriaService`: acá SÍ se
 * escribe, así que cada guardado deja rastro de quién lo hizo.
 *
 * No importa ningún módulo de `erp/planilla/`: las consultas son propias y acotadas
 * por empresa. Reusar un service del estudio —que consulta sobre las 171 empresas y no
 * filtra por ninguna— es exactamente el agujero que el área `cliente/` existe para
 * evitar.
 */
@Module({
  imports: [CommonModule],
  controllers: [AsistenciaClienteController],
  providers: [AsistenciaClienteService],
  exports: [AsistenciaClienteService],
})
export class AsistenciaClienteModule {}

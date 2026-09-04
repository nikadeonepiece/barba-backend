import { Module } from '@nestjs/common';
import { GuiasSunatModule } from './guias-sunat/guias-sunat.module';
import { ParametrosTributariosModule } from './parametros-tributarios/parametros-tributarios.module';

@Module({
  imports: [GuiasSunatModule, ParametrosTributariosModule],
  exports: [GuiasSunatModule, ParametrosTributariosModule],
})
export class ConfiguracionesModule {}

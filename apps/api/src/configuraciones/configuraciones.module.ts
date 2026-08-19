import { Module } from '@nestjs/common';
import { GuiasSunatModule } from './guias-sunat/guias-sunat.module';

@Module({
  imports: [GuiasSunatModule],
  exports: [GuiasSunatModule],
})
export class ConfiguracionesModule {}

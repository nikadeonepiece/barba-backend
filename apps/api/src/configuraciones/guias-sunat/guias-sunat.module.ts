import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { GuiasSunatController } from './guias-sunat.controller';
import { GuiasSunatService } from './guias-sunat.service';

@Module({
  imports: [CommonModule],
  controllers: [GuiasSunatController],
  providers: [GuiasSunatService],
  exports: [GuiasSunatService],
})
export class GuiasSunatModule {}

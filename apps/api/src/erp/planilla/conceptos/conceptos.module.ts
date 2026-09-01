import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { ConceptosController } from './conceptos.controller';
import { ConceptosService } from './conceptos.service';

@Module({
  imports: [CommonModule],
  controllers: [ConceptosController],
  providers: [ConceptosService],
  exports: [ConceptosService],
})
export class ConceptosModule {}

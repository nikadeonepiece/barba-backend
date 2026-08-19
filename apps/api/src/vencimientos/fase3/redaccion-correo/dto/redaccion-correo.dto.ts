import { IsString, IsIn, MaxLength, IsOptional } from 'class-validator';

export class RedactarCorreoDto {
  @IsString()
  @MaxLength(2000)
  contexto!: string; // lo que el usuario quiere comunicar, en sus palabras

  @IsIn(['formal', 'cercano', 'urgente'])
  tono!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  destinatario?: string; // ej: "gerente general", "dueño de PYME"
}

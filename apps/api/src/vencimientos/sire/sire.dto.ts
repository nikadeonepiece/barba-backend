import { IsIn, IsString, Length, IsInt, IsPositive } from 'class-validator';

export class GenerarDescargaSireDto {
  @IsInt()
  @IsPositive()
  id_empresa!: number;

  @IsIn(['RVIE', 'RCE'])
  tipo_libro!: 'RVIE' | 'RCE';

  @IsString()
  @Length(6, 6)
  periodo!: string;
}

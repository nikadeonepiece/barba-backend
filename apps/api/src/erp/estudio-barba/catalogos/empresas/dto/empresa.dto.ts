import { IsString, IsOptional, IsIn, IsInt, IsPositive, Matches, MaxLength, IsNotEmpty, IsEmail, MinLength } from 'class-validator';
import { PartialType, OmitType } from '@nestjs/mapped-types';

export class CreateEmpresaDto {
  @IsString()
  @MaxLength(200)
  razon_social!: string;

  // RUC peruano: 11 dígitos exactos, solo numérico — `@Length(11,11)` solo por sí sola
  // dejaba pasar cualquier string de 11 caracteres (letras incluidas).
  @IsString()
  @Matches(/^\d{11}$/, { message: 'ruc debe tener exactamente 11 dígitos numéricos' })
  ruc!: string;

  @IsIn(['MYPE', 'RER', 'NRUS', 'R.GENERAL'])
  regimen_tributario!: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  id_encargado_contable?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  id_encargado_laboral?: number;
}

// El RUC no se actualiza una vez creada la empresa (es la llave del cronograma) —
// se omite del PartialType en vez de heredarlo como opcional, para que ni siquiera
// sea un campo válido en el body de un PUT.
export class UpdateEmpresaDto extends PartialType(OmitType(CreateEmpresaDto, ['ruc'] as const)) {
  @IsOptional()
  @IsIn(['ACTIVO', 'INACTIVO'])
  estado_cliente?: string;

  @IsOptional()
  @IsIn(['ACTIVO', 'SUSPENDIDA', 'BAJA_DEFINITIVA'])
  estado_sunat?: string;

  @IsOptional()
  @IsString()
  observaciones?: string;
}

export class GuardarCredencialesDto {
  @IsOptional()
  @IsString()
  sunat_sol_usuario?: string;

  @IsOptional()
  @IsString()
  sunat_sol_password?: string;

  @IsOptional()
  @IsString()
  sunat_api_client_id?: string;

  @IsOptional()
  @IsString()
  sunat_api_client_secret?: string;
}

// ── Cuentas del PORTAL CLIENTE de una empresa ────────────────────────────────
// Son usuarios de `sis_usuario` con `id_empresa` puesto, dados de alta desde el
// modal "Usuarios del portal" de catalogos/empresas.
//
// `id_empresa` NO está en ninguno de estos DTOs a propósito: sale del `:id` de la
// URL, que ya pasó por el permiso de la empresa. Aceptarlo en el body dejaría crear
// una cuenta con acceso a OTRA empresa desde la pantalla de esta (IDOR).

export class CreateUsuarioPortalDto {
  // El rol no es libre: el service lo valida contra los roles de portal reales
  // (ver `rolesPortal()`). Un `id_rol` del estudio acá le daría a un externo una
  // cuenta con los permisos del estudio.
  @IsInt()
  @IsPositive()
  id_rol!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nombres!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  apellidos!: string;

  @IsEmail({}, { message: 'Correo inválido' })
  @MaxLength(150)
  correo!: string;

  // 8 y no los 6 de `CreateUsuarioDto`: esta clave se le entrega a alguien de afuera
  // del estudio y viaja por correo o WhatsApp hasta que la persona la cambia.
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password!: string;
}

// Sin `password`: cambiarla es una operación aparte (`PUT :id/usuarios/:idUsuario/password`)
// para que un guardado de nombre/correo no la pise por accidente con un campo vacío.
export class UpdateUsuarioPortalDto extends PartialType(OmitType(CreateUsuarioPortalDto, ['password'] as const)) {}

export class ResetPasswordUsuarioPortalDto {
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password!: string;
}

export class CambiarEstadoUsuarioPortalDto {
  // Solo estos dos: 'ELIMINADO' es baja definitiva y tiene su propio endpoint
  // (`DELETE`), que además audita como ELIMINAR.
  @IsIn(['ACTIVO', 'BLOQUEADO'])
  estado_registro!: string;
}

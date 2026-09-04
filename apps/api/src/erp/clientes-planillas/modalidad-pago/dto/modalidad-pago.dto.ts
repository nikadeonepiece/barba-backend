import { IsIn } from 'class-validator';

/** Las cuatro modalidades son el ENUM de `planilla_trabajador.modalidad_pago`. */
export const MODALIDADES_PAGO = ['MENSUAL', 'JORNAL', 'HORA', 'DESTAJO'];

/**
 * DTO parcial a propósito: lleva UN solo campo.
 *
 * El resto de la ficha del trabajador (sueldo, régimen, AFP, cuentas bancarias) lo
 * administra el estudio desde la intranet. Si este DTO fuera un `PartialType` de la
 * ficha completa, el `ValidationPipe` aceptaría un `sueldo_basico` en el body y quien
 * escribiera el UPDATE mañana tendría que acordarse de excluirlo. Con un DTO de un
 * campo, el contrato lo dice solo: acá se cambia la modalidad y nada más.
 *
 * El `@IsIn` no es redundante con el ENUM de la base: sin él, un valor fuera de rango
 * llega al UPDATE y MySQL responde 500 genérico (o, con el sql_mode relajado, guarda
 * la cadena vacía SIN avisar). Con el `@IsIn` el usuario recibe un 400 que dice qué
 * valores existen.
 */
export class CambiarModalidadPagoDto {
  @IsIn(MODALIDADES_PAGO)
  modalidad_pago!: string;
}

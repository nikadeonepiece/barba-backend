import { ForbiddenException } from '@nestjs/common';

/**
 * Devuelve la empresa sobre la que puede consultar el usuario del PORTAL CLIENTE, o
 * corta la petición.
 *
 * ── Por qué existe esta función y no un `req.user.idEmpresa` suelto en cada service ──
 *
 * Es el único punto donde se decide el alcance de TODA consulta del portal. Todos los
 * services de `erp/cliente/` empiezan llamándola y meten el resultado en el `WHERE`.
 * Repetir `req.user.idEmpresa ?? 0` a mano en veinte queries es cómo aparece el caso
 * que se olvidó — y ese caso devuelve las planillas de otra empresa.
 *
 * ── Por qué no alcanza con los permisos ──
 *
 * `PermissionsGuard` responde "este rol puede ver planillas del cliente", que es una
 * pregunta sobre PANTALLAS. La pregunta que falta es sobre FILAS: cuáles. Un usuario
 * con el permiso correcto pero de otra empresa pasa el guard sin problema; lo que lo
 * detiene es que su `id_empresa` no esté en el WHERE de la fila que pidió.
 *
 * ── Por qué el valor sale del token ──
 *
 * `idEmpresa` lo firma `AuthService` dentro del JWT y lo expone `JwtStrategy.validate()`.
 * Si viniera de un query param o del body, cambiar un número en la URL bastaría para
 * leer los sueldos de otra empresa (IDOR — es la regla que CLAUDE.md pide verificar en
 * todo módulo con scope).
 *
 * ── Por qué 403 y no 401 ──
 *
 * El usuario está autenticado: el token es válido. Lo que no tiene es empresa asignada
 * (es personal del estudio entrando por una URL del portal, o un cliente al que nunca
 * se le terminó de configurar la cuenta). Un 401 lo mandaría a re-loguearse, y volvería
 * a caer en lo mismo sin entender por qué.
 */
export function resolverEmpresaDelUsuario(user: any): number {
  const idEmpresa = Number(user?.idEmpresa);

  if (!idEmpresa || Number.isNaN(idEmpresa)) {
    throw new ForbiddenException(
      'Tu usuario no está asociado a ninguna empresa, así que el portal no puede saber qué información mostrarte. Pedile al estudio que asocie tu cuenta a tu empresa.',
    );
  }

  return idEmpresa;
}

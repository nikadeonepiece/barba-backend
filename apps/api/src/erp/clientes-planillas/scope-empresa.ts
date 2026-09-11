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

/**
 * ¿Este usuario es una cuenta de PORTAL (una empresa) o del estudio?
 *
 * Sale del token, nunca del body: `sis_usuario.id_empresa` lo firma `AuthService` y lo
 * expone `JwtStrategy.validate()`. El personal del estudio no tiene empresa asignada.
 */
export function esUsuarioDePortal(user: any): boolean {
  const idEmpresa = Number(user?.idEmpresa);
  return !!idEmpresa && !Number.isNaN(idEmpresa);
}

/**
 * La empresa que de verdad se va a usar en el WHERE, para las pantallas que atienden a
 * los DOS públicos (centros de costo, requerimientos).
 *
 * · Cuenta de PORTAL → siempre su empresa, y se IGNORA lo que haya mandado el frontend.
 *   Ese "ignora" es el punto entero de la función: si respetara el parámetro, cambiar un
 *   número en la URL bastaría para leer los centros de costo de otra empresa (IDOR).
 * · Personal del ESTUDIO → lo que eligió en el desplegable, o `undefined` para ver todo.
 *
 * Es el complemento de `resolverEmpresaDelUsuario`: aquella corta la petición de quien
 * no tiene empresa; esta convive con quien legítimamente no la tiene.
 */
export function empresaEfectiva(user: any, idEmpresaFiltro?: number | string | null): number | undefined {
  if (esUsuarioDePortal(user)) return Number(user.idEmpresa);

  const filtro = Number(idEmpresaFiltro);
  return filtro && !Number.isNaN(filtro) ? filtro : undefined;
}

/**
 * Corta la petición si un usuario de portal intenta tocar una fila de otra empresa.
 *
 * Hace falta además del filtro del listado: filtrar el LISTADO por empresa no impide
 * que alguien mande `PUT /categorias/5000` con el id de una fila que nunca vio. El
 * `WHERE` del UPDATE es el otro candado; este da el mensaje claro y evita el 404
 * engañoso.
 */
export function asegurarEmpresaPropia(user: any, idEmpresaDelRegistro: number | null | undefined): void {
  if (!esUsuarioDePortal(user)) return;

  if (Number(idEmpresaDelRegistro) !== Number(user.idEmpresa)) {
    throw new ForbiddenException('Ese registro pertenece a otra empresa.');
  }
}

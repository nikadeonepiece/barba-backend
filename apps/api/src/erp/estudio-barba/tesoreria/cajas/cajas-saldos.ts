import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * El saldo de una caja chica, en un solo lugar.
 *
 * Esto vive fuera de `CajasService` porque HAY DOS PANTALLAS que mueven la misma caja:
 * la del estudio (`tesoreria/cajas`) y la de la empresa en el portal
 * (`clientes-planillas/cajas`). Cada una tiene su service —el del portal filtra por
 * empresa y el de la intranet no— pero el saldo tiene que salir del MISMO cálculo. Dos
 * implementaciones de "cuánto queda en la caja" es la forma segura de que el cliente y
 * el contador vean números distintos de la misma plata.
 *
 * Lo que se comparte es el cálculo, no el permiso: estas funciones reciben un `id_caja`
 * que quien llama YA verificó que puede tocar. No validan pertenencia y no deben
 * hacerlo — ese es trabajo del service, que es el único que sabe de qué empresa habla.
 */

/**
 * El movimiento que representa el fondo con el que se abrió la caja.
 *
 * No se edita ni se anula desde la pantalla de movimientos: es el reflejo de
 * `caja_chica.monto_inicial`, y tocarlo por un lado sin el otro descuadra el saldo. Se
 * corrige editando la cabecera de la caja, que actualiza los dos.
 */
export const ORIGEN_APERTURA = 'caja_chica_apertura';

/**
 * Un movimiento solo es PLATA cuando está registrado y vivo.
 *
 * `estado` dice si el movimiento sigue en pie (un ANULADO no cuenta) y `estado_registro`
 * si la fila existe. Esta condición es la ÚNICA definición de "cuenta para el saldo" en
 * todo el módulo: escrita a mano en otra query, es un lugar más donde el saldo puede
 * empezar a diferir.
 *
 * El `alias` existe porque las consultas del portal unen `caja_chica` con
 * `caja_chica_movimiento` y las dos tablas tienen `estado` y `estado_registro`: sin el
 * prefijo, MySQL corta con "Column 'estado' in field list is ambiguous".
 */
export const cuentaParaSaldo = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return `${p}estado = 'REGISTRADO' AND ${p}estado_registro = 'ACTIVO'`;
};

export const CUENTA_PARA_SALDO = cuentaParaSaldo();

/** El driver de MySQL devuelve DECIMAL y COUNT como string; sin esto, `+` concatena. */
export const num = (v: any) => Number(v ?? 0);
export const soles = (v: any) => `S/ ${num(v).toFixed(2)}`;
export const fechaPe = (v: any) => (v ? new Date(v).toLocaleDateString('es-PE') : '—');

/**
 * Bloquea la caja para el resto de la transacción y valida que acepte cambios.
 *
 * El `FOR UPDATE` es lo que impide que dos movimientos simultáneos lean el mismo saldo,
 * los dos pasen la validación y la caja termine en negativo. El `disabled` del botón en
 * el frontend no protege de esto (dos pestañas, dos usuarios, un reintento de red), y
 * ahora menos que nunca: la misma caja se toca desde la intranet y desde el portal.
 *
 * Recibe el `QueryRunner` en vez de abrir uno propio: abrir una transacción dentro de
 * otra deja la de afuera sin efecto sobre estas queries.
 */
export async function bloquearCaja(qr: QueryRunner, idCaja: number, exigirAbierta = true): Promise<any> {
  const [caja] = await qr.query(
    `SELECT * FROM caja_chica WHERE id_caja = ? AND estado_registro = 'ACTIVO' FOR UPDATE`,
    [idCaja],
  );
  if (!caja) throw new NotFoundException('Caja no encontrada');
  if (exigirAbierta && caja.estado === 'CERRADA') {
    throw new BadRequestException(
      'Esta caja está cerrada y ya no acepta cambios. Abre una caja nueva para el periodo siguiente.',
    );
  }
  return caja;
}

/**
 * Recalcula el saldo corrido de TODA la caja y lo baja a `caja_chica.saldo_actual`.
 * Devuelve el saldo final y el punto MÁS BAJO de la cadena, con su fecha.
 *
 * Por qué recalcular en vez de sumar la diferencia:
 *
 *   · Un movimiento se registra con la fecha que el usuario elige, y esa fecha puede ser
 *     ANTERIOR a movimientos ya cargados (la boleta apareció una semana después). Con
 *     ajustes incrementales, el `saldo_posterior` de las filas siguientes se queda con
 *     el valor viejo y la columna SALDO del estado de cuenta deja de cuadrar.
 *   · Corregir el fondo de apertura tiene el mismo efecto sobre TODA la historia.
 *
 * El costo es aceptable: una caja chica se mide en decenas de movimientos por mes y la
 * ventana la resuelve MySQL en una sola sentencia (nada de N updates en un loop). Los
 * ANULADOS entran en la cadena con delta 0: siguen visibles, pero no mueven plata.
 *
 * Devuelve también el MÍNIMO porque validar solo el saldo final no alcanza: un fondo mal
 * corregido, o un gasto cargado con fecha vieja, puede terminar en positivo y aun así
 * dejar la caja en rojo en el medio — y una caja no pudo gastar plata que en ese momento
 * no tenía. Quien llame valida `minimo` y deja que el rollback deshaga todo.
 */
export async function recalcularSaldos(
  qr: QueryRunner, idCaja: number, userId: number,
): Promise<{ saldo: number; minimo: number; fechaMinimo: string | null }> {
  await qr.query(
    `UPDATE caja_chica_movimiento m
     INNER JOIN (
       SELECT id_movimiento, delta,
              SUM(delta) OVER (ORDER BY fecha, id_movimiento ROWS UNBOUNDED PRECEDING) AS posterior
       FROM (
         SELECT id_movimiento, fecha,
                CASE WHEN ${CUENTA_PARA_SALDO}
                     THEN CASE WHEN tipo = 'INGRESO' THEN monto ELSE -monto END
                     ELSE 0 END AS delta
         FROM caja_chica_movimiento
         WHERE id_caja = ? AND estado_registro = 'ACTIVO'
       ) base
     ) x ON x.id_movimiento = m.id_movimiento
     SET m.saldo_anterior = x.posterior - x.delta,
         m.saldo_posterior = x.posterior`,
    [idCaja],
  );

  // El saldo de la caja es el último eslabón de esa cadena. `COALESCE` cubre la caja que
  // se quedó sin ningún movimiento activo: un 0 explícito es mejor que un NULL que
  // después se lee como "sin datos".
  const [fila] = await qr.query(
    `SELECT COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO}
                              THEN CASE WHEN tipo = 'INGRESO' THEN monto ELSE -monto END
                              ELSE 0 END), 0) AS saldo
     FROM caja_chica_movimiento
     WHERE id_caja = ? AND estado_registro = 'ACTIVO'`,
    [idCaja],
  );
  const saldo = num(fila?.saldo);

  // El punto más bajo y CUÁNDO ocurre: sin la fecha, el mensaje de error obliga al
  // usuario a revisar el libro entero para encontrar qué corregir.
  const [bajo] = await qr.query(
    `SELECT saldo_posterior, fecha FROM caja_chica_movimiento
     WHERE id_caja = ? AND estado_registro = 'ACTIVO'
     ORDER BY saldo_posterior ASC, fecha ASC
     LIMIT 1`,
    [idCaja],
  );

  await qr.query(`UPDATE caja_chica SET saldo_actual = ?, id_usuario_mod = ? WHERE id_caja = ?`, [saldo, userId, idCaja]);

  return {
    saldo,
    minimo: bajo ? num(bajo.saldo_posterior) : saldo,
    fechaMinimo: bajo?.fecha ?? null,
  };
}

/**
 * El concepto es opcional, pero si viene tiene que existir y servir para ese tipo de
 * movimiento: un "Ajuste por arqueo" vale para los dos lados, "Movilidad" no es un
 * ingreso. Sin esta validación se guardan gastos etiquetados como reposiciones y el
 * reporte por concepto deja de significar algo.
 */
export async function validarConcepto(
  ds: DataSource, idConcepto: number | undefined, tipoMovimiento: string,
): Promise<number | null> {
  if (!idConcepto) return null;

  const [concepto] = await ds.query(
    `SELECT id_caja_concepto, nombre, tipo FROM caja_chica_concepto
     WHERE id_caja_concepto = ? AND estado_registro = 'ACTIVO'`,
    [idConcepto],
  );
  if (!concepto) throw new BadRequestException('El concepto seleccionado no existe o fue dado de baja');

  const esperado = tipoMovimiento === 'EGRESO' ? 'GASTO' : 'INGRESO';
  if (concepto.tipo !== 'AMBOS' && concepto.tipo !== esperado) {
    throw new BadRequestException(
      `El concepto "${concepto.nombre}" es de tipo ${concepto.tipo} y no se puede usar en un ${tipoMovimiento.toLowerCase()}.`,
    );
  }
  return Number(concepto.id_caja_concepto);
}

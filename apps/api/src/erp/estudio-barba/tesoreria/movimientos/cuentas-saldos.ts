import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

/**
 * El saldo de una cuenta bancaria, en un solo lugar.
 *
 * Vive fuera de los services porque DOS módulos mueven la misma cuenta: la pantalla de
 * movimientos (esta carpeta) y la de cuentas, que puede corregir el saldo inicial. Y
 * mañana serán tres, cuando los abonos de las órdenes de pago registren su movimiento
 * acá. Dos implementaciones de "cuánto hay en la cuenta" es la forma segura de que dos
 * pantallas muestren números distintos de la misma plata.
 *
 * Es el mismo criterio —y casi el mismo código— que `cajas-saldos.ts`. No se
 * reutiliza ese archivo porque son otras tablas y otra regla: una caja chica no puede
 * quedar en negativo nunca, una cuenta bancaria sí (un sobregiro existe).
 */

/** Un movimiento solo es PLATA cuando está registrado y vivo. */
export const cuentaParaSaldo = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return `${p}estado = 'REGISTRADO' AND ${p}estado_registro = 'ACTIVO'`;
};

export const CUENTA_PARA_SALDO = cuentaParaSaldo();

/** El driver de MySQL devuelve DECIMAL y COUNT como string; sin esto, `+` concatena. */
export const num = (v: any) => Number(v ?? 0);

/** Formatea con el símbolo de la moneda de la cuenta, no siempre soles. */
export const money = (v: any, moneda: string = 'PEN') =>
  `${moneda === 'USD' ? 'US$' : 'S/'} ${num(v).toFixed(2)}`;

export const fechaPe = (v: any) => (v ? new Date(v).toLocaleDateString('es-PE') : '—');

/**
 * Bloquea la cuenta para el resto de la transacción.
 *
 * El `FOR UPDATE` es lo que impide que dos movimientos simultáneos lean el mismo saldo
 * y lo escriban pisándose. El `disabled` del botón en el frontend no protege de esto:
 * dos pestañas, dos usuarios o un reintento de red bastan.
 *
 * Recibe el `QueryRunner` en vez de abrir uno propio: abrir una transacción dentro de
 * otra deja la de afuera sin efecto sobre estas queries.
 */
export async function bloquearCuenta(qr: QueryRunner, idCuenta: number): Promise<any> {
  const [cuenta] = await qr.query(
    `SELECT * FROM tesoreria_cuenta WHERE id_cuenta = ? AND estado_registro = 'ACTIVO' FOR UPDATE`,
    [idCuenta],
  );
  if (!cuenta) throw new NotFoundException('La cuenta no existe o fue dada de baja.');
  return cuenta;
}

/**
 * Recalcula el saldo corrido de TODA la cuenta y lo baja a `tesoreria_cuenta.saldo_actual`.
 *
 * Por qué recalcular en vez de sumar la diferencia: un movimiento se registra con la
 * fecha que elige el usuario, y esa fecha puede ser ANTERIOR a movimientos ya cargados
 * (el voucher apareció una semana después). Con ajustes incrementales, el
 * `saldo_posterior` de las filas siguientes se queda con el valor viejo y la columna
 * SALDO del estado de cuenta deja de cuadrar. Corregir el saldo inicial tiene el mismo
 * efecto sobre toda la historia.
 *
 * El saldo arranca en `saldo_inicial`: es la foto con la que la cuenta entró al
 * sistema, no un movimiento. (En cajas chicas la apertura SÍ es un movimiento; acá no,
 * porque una cuenta bancaria no se "abre" en el ERP — ya existía en el banco.)
 *
 * Los ANULADOS entran en la cadena con delta 0: siguen visibles, pero no mueven plata.
 */
export async function recalcularSaldosCuenta(
  qr: QueryRunner, idCuenta: number, userId: number,
): Promise<{ saldo: number; saldoInicial: number }> {
  const [cuenta] = await qr.query(
    `SELECT saldo_inicial FROM tesoreria_cuenta WHERE id_cuenta = ?`, [idCuenta],
  );
  const saldoInicial = num(cuenta?.saldo_inicial);

  await qr.query(
    `UPDATE tesoreria_movimiento m
     INNER JOIN (
       SELECT id_movimiento, delta,
              ? + SUM(delta) OVER (ORDER BY fecha, id_movimiento ROWS UNBOUNDED PRECEDING) AS posterior
       FROM (
         SELECT id_movimiento, fecha,
                CASE WHEN ${CUENTA_PARA_SALDO}
                     THEN CASE WHEN tipo = 'INGRESO' THEN monto ELSE -monto END
                     ELSE 0 END AS delta
         FROM tesoreria_movimiento
         WHERE id_cuenta = ? AND estado_registro = 'ACTIVO'
       ) base
     ) x ON x.id_movimiento = m.id_movimiento
     SET m.saldo_anterior = x.posterior - x.delta,
         m.saldo_posterior = x.posterior`,
    [saldoInicial, idCuenta],
  );

  const [fila] = await qr.query(
    `SELECT COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO}
                              THEN CASE WHEN tipo = 'INGRESO' THEN monto ELSE -monto END
                              ELSE 0 END), 0) AS movido
     FROM tesoreria_movimiento
     WHERE id_cuenta = ? AND estado_registro = 'ACTIVO'`,
    [idCuenta],
  );

  const saldo = Math.round((saldoInicial + num(fila?.movido)) * 100) / 100;

  await qr.query(
    `UPDATE tesoreria_cuenta SET saldo_actual = ?, id_usuario_mod = ? WHERE id_cuenta = ?`,
    [saldo, userId, idCuenta],
  );

  return { saldo, saldoInicial };
}

/**
 * La moneda del movimiento tiene que ser la de la cuenta, salvo que venga tipo de cambio.
 *
 * Un depósito en dólares a una cuenta en soles existe, pero entonces hace falta saber a
 * qué tipo de cambio se convirtió: sin ese dato el saldo suma peras con manzanas y el
 * error recién se ve al conciliar con el banco.
 */
export function validarMoneda(monedaMovimiento: string, monedaCuenta: string, tipoCambio?: number | null) {
  if (monedaMovimiento === monedaCuenta) return;
  if (!tipoCambio || Number(tipoCambio) <= 0) {
    throw new BadRequestException(
      `El movimiento es en ${monedaMovimiento} y la cuenta es en ${monedaCuenta}: indicá el tipo de cambio usado, ` +
      'o registrá el movimiento en la moneda de la cuenta.',
    );
  }
}

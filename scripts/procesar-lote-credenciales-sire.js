// Procesa por TANDAS el registro/extracción de Client ID/Secret SIRE para varias
// empresas cliente, con pausas entre cada una y entre tandas — para no repetir el
// bloqueo de WAF de SUNAT ya documentado (~8 sesiones seguidas) en
// apps/api/src/vencimientos/fase2/sunat-scraping.client.ts.
//
// Uso:
//   node scripts/procesar-lote-credenciales-sire.js [tamañoTanda] [cantidadTandas]
// Defaults: tamañoTanda=6, cantidadTandas=1 (una sola tanda por ejecución — se vuelve a
// correr el comando para la siguiente tanda, así el usuario controla el ritmo real).
//
// Solo toma empresas SIN client_id todavía (evita reprocesar las ya resueltas) y con
// usuario/clave SOL ya guardados. Si 3 empresas seguidas fallan con el mismo tipo de
// error de RED/timeout (no de credenciales), se detiene — señal probable de bloqueo.
//
// Todo se guarda SOLO en la tabla `empresa` (cifrado) — nunca en bd.sql, para que un
// futuro `bd.sql` (que arranca con DROP DATABASE) no borre lo ya obtenido.

require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { extraerCredencialesSire, cifrar } = require('./lib/sire-credenciales-lib');

function descifrar(buffer, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

const PAUSA_ENTRE_EMPRESAS_MS = 25_000; // 25s entre cada login — evita ráfaga de sesiones
const PAUSA_ENTRE_TANDAS_MS = 90_000; // 90s entre tandas dentro de la misma ejecución
const MAX_FALLOS_RED_SEGUIDOS = 3; // corta si detecta patrón de posible bloqueo

async function main() {
  const tamañoTanda = Number(process.argv[2]) || 6;
  const cantidadTandas = Number(process.argv[3]) || 1;

  const key = process.env.CREDENCIALES_ENCRYPTION_KEY;
  if (!key) { console.error('Falta CREDENCIALES_ENCRYPTION_KEY en .env'); process.exit(1); }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  let fallosRedSeguidos = 0;
  const resumen = { exitosas: [], sinAplicacion: [], errorCredenciales: [], errorOtro: [] };

  for (let tanda = 0; tanda < cantidadTandas; tanda++) {
    const [pendientes] = await conn.query(
      `SELECT id_empresa, ruc, razon_social, sunat_sol_usuario, sunat_sol_password
       FROM empresa
       WHERE estado_registro = 'ACTIVO' AND estado_cliente = 'ACTIVO'
         AND sunat_sol_usuario IS NOT NULL AND sunat_sol_password IS NOT NULL
         AND sunat_api_client_id IS NULL
       ORDER BY id_empresa
       LIMIT ?`,
      [tamañoTanda],
    );

    if (pendientes.length === 0) {
      console.log('No quedan empresas pendientes (con SOL guardado y sin client_id todavía).');
      break;
    }

    console.log(`\n=== Tanda ${tanda + 1}/${cantidadTandas} — ${pendientes.length} empresas ===`);

    for (const [i, row] of pendientes.entries()) {
      console.log(`\n[${i + 1}/${pendientes.length}] ${row.ruc} — ${row.razon_social}`);

      await conn.query(
        `INSERT INTO sire_credenciales_registro (id_empresa, estado, id_usuario_crea)
         VALUES (?, 'EN_PROCESO', 1)
         ON DUPLICATE KEY UPDATE estado = 'EN_PROCESO', mensaje_error = NULL, fecha_intento = NOW()`,
        [row.id_empresa],
      );

      let empresaDesc;
      try {
        empresaDesc = {
          id_empresa: row.id_empresa,
          ruc: row.ruc,
          usuarioSol: descifrar(row.sunat_sol_usuario, key),
          claveSol: descifrar(row.sunat_sol_password, key),
        };
      } catch (e) {
        console.error('  Error descifrando credenciales SOL guardadas:', e.message);
        await conn.query(`UPDATE sire_credenciales_registro SET estado='ERROR', mensaje_error=? WHERE id_empresa=?`, [`Error descifrando SOL: ${e.message}`, row.id_empresa]);
        resumen.errorOtro.push(row.ruc);
        continue;
      }

      const resultado = await extraerCredencialesSire(empresaDesc);

      if (resultado.ok) {
        await conn.query(
          `UPDATE empresa SET sunat_api_client_id = ?, sunat_api_client_secret = ? WHERE id_empresa = ?`,
          [cifrar(resultado.clientId, key), cifrar(resultado.clientSecret, key), row.id_empresa],
        );
        await conn.query(
          `UPDATE sire_credenciales_registro SET estado='EXITOSO', fecha_exito=NOW(), mensaje_error=? WHERE id_empresa=?`,
          [resultado.scopeSireActivo ? null : 'ADVERTENCIA: scope "MIGE RCE y RVIE - SIRE" no está marcado — revisar manualmente', row.id_empresa],
        );
        console.log(`  OK — client_id: ${resultado.clientId.slice(0, 8)}... | scope SIRE: ${resultado.scopeSireActivo}`);
        resumen.exitosas.push(row.ruc);
        fallosRedSeguidos = 0;
      } else if (resultado.sinAplicacion) {
        await conn.query(
          `UPDATE sire_credenciales_registro SET estado='ERROR', mensaje_error=? WHERE id_empresa=?`,
          ['SIN_APLICACION: no tiene aplicación SIRE registrada en el portal — requiere flujo de registro nuevo (no implementado todavía)', row.id_empresa],
        );
        console.log('  SIN APLICACIÓN REGISTRADA — pendiente de flujo de registro nuevo');
        resumen.sinAplicacion.push(row.ruc);
        fallosRedSeguidos = 0;
      } else {
        const esCredencial = /incorrect/i.test(resultado.error || '');
        await conn.query(`UPDATE sire_credenciales_registro SET estado='ERROR', mensaje_error=? WHERE id_empresa=?`, [resultado.error, row.id_empresa]);
        console.error('  ERROR:', resultado.error);
        if (esCredencial) {
          resumen.errorCredenciales.push(row.ruc);
          fallosRedSeguidos = 0;
        } else {
          resumen.errorOtro.push(row.ruc);
          fallosRedSeguidos++;
        }
      }

      if (fallosRedSeguidos >= MAX_FALLOS_RED_SEGUIDOS) {
        console.error(`\n⚠️  ${MAX_FALLOS_RED_SEGUIDOS} fallos no-atribuibles-a-credenciales seguidos — probable bloqueo de SUNAT. Deteniendo el lote.`);
        tanda = cantidadTandas; // corta también el loop externo de tandas
        break;
      }

      if (i < pendientes.length - 1) {
        console.log(`  (pausa ${PAUSA_ENTRE_EMPRESAS_MS / 1000}s...)`);
        await new Promise((r) => setTimeout(r, PAUSA_ENTRE_EMPRESAS_MS));
      }
    }

    if (tanda < cantidadTandas - 1 && fallosRedSeguidos < MAX_FALLOS_RED_SEGUIDOS) {
      console.log(`\n(pausa entre tandas ${PAUSA_ENTRE_TANDAS_MS / 1000}s...)`);
      await new Promise((r) => setTimeout(r, PAUSA_ENTRE_TANDAS_MS));
    }
  }

  console.log('\n=== RESUMEN ===');
  console.log('Exitosas:', resumen.exitosas.length, resumen.exitosas);
  console.log('Sin aplicación registrada:', resumen.sinAplicacion.length, resumen.sinAplicacion);
  console.log('Error credenciales SOL:', resumen.errorCredenciales.length, resumen.errorCredenciales);
  console.log('Otro error:', resumen.errorOtro.length, resumen.errorOtro);

  await conn.end();
}

main().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });

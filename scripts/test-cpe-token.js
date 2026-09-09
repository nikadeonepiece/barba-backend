// PROBE (solo paso 1): ¿las credenciales de API ya registradas para una empresa
// sirven también para el servicio CPE (descarga masiva de XML), o hay que generar
// un client_id/secret aparte en SOL?
//
// Esto NO descarga nada todavía. Solo pide un token OAuth2 por cada scope candidato
// y reporta qué responde SUNAT. Es el único dato que decide si el módulo de detalle
// de productos es viable con lo que ya está configurado.
//
// OJO: se pausa 3s entre intentos a propósito. Ver sunat-sire.client.ts — golpear
// api-seguridad.sunat.gob.pe en ráfaga parece fuerza bruta y el WAF corta la IP.
//
// Uso: node test-cpe-token.js <RUC> [RUC2 RUC3 ...]
require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');

// Scopes candidatos, del más probable al menos. Se prueban en orden y se reportan
// TODOS los resultados — un 401 acá es información, no un fallo del script.
const SCOPES = [
  'https://api-cpe.sunat.gob.pe',
  'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes',
  'https://api-sire.sunat.gob.pe', // control: este ya sabemos que funciona
];

function descifrar(buffer, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rucs = process.argv.slice(2);
  if (!rucs.length) { console.error('Uso: node test-cpe-token.js <RUC> [RUC2 ...]'); process.exit(1); }

  const key = process.env.CREDENCIALES_ENCRYPTION_KEY;
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
  });
  const [filas] = await conn.query(
    `SELECT ruc, razon_social, sunat_sol_usuario, sunat_sol_password, sunat_api_client_id, sunat_api_client_secret
       FROM empresa WHERE ruc IN (?)`,
    [rucs],
  );
  await conn.end();

  for (const ruc of rucs) {
    const empresa = filas.find((f) => String(f.ruc) === ruc);
    console.log('\n############ RUC', ruc, empresa ? `— ${empresa.razon_social}` : '', '############');
    if (!empresa) { console.log('  Empresa no encontrada en BD — se salta'); continue; }
    // Sin client_id no hay nada que probar: el OAuth de SUNAT lo lleva en la propia URL.
    if (!empresa.sunat_api_client_id) { console.log('  SIN client_id de API SUNAT configurado — se salta'); continue; }
    await probarEmpresa(ruc, empresa, key);
  }
}

async function probarEmpresa(ruc, empresa, key) {
  const usuarioSol = descifrar(empresa.sunat_sol_usuario, key).trim();
  const claveSol = descifrar(empresa.sunat_sol_password, key).trim();
  const clientId = descifrar(empresa.sunat_api_client_id, key).trim();
  const clientSecret = descifrar(empresa.sunat_api_client_secret, key).trim();

  const oauthUrl = `https://api-seguridad.sunat.gob.pe/v1/clientessol/${clientId}/oauth2/token`;

  for (const scope of SCOPES) {
    console.log('\n=== scope:', scope, '===');
    const body = new URLSearchParams({
      grant_type: 'password', scope, client_id: clientId, client_secret: clientSecret,
      username: `${ruc}${usuarioSol}`, password: claveSol,
    });
    try {
      const resp = await fetch(oauthUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await resp.json().catch(() => null);
      if (resp.ok && data?.access_token) {
        console.log('  OK — TOKEN CONCEDIDO: este scope está habilitado para estas credenciales');
      } else {
        console.log(`  FALLO ${resp.status} — ${data?.error_description || data?.error || JSON.stringify(data)}`);
      }
    } catch (e) {
      console.log('  error de red:', e.message);
    }
    await dormir(3000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

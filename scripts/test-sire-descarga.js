// Prueba end-to-end del flujo SIRE (RVIE) contra SUNAT real, replicando la lógica de
// apps/api/src/vencimientos/sire/sire.service.ts fuera de NestJS para validar rápido.
// Uso: node test-sire-descarga.js <RUC> <PERIODO_AAAAMM>
require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');

function descifrar(buffer, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function main() {
  const ruc = process.argv[2];
  const periodo = process.argv[3];
  if (!ruc || !periodo) { console.error('Uso: node test-sire-descarga.js <RUC> <AAAAMM>'); process.exit(1); }

  const key = process.env.CREDENCIALES_ENCRYPTION_KEY;
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
  });
  const [[empresa]] = await conn.query(
    `SELECT id_empresa, ruc, sunat_sol_usuario, sunat_sol_password, sunat_api_client_id, sunat_api_client_secret FROM empresa WHERE ruc = ?`,
    [ruc],
  );
  await conn.end();
  if (!empresa) { console.error('Empresa no encontrada'); process.exit(1); }

  const usuarioSol = descifrar(empresa.sunat_sol_usuario, key);
  const claveSol = descifrar(empresa.sunat_sol_password, key);
  const clientId = descifrar(empresa.sunat_api_client_id, key);
  const clientSecret = descifrar(empresa.sunat_api_client_secret, key);

  console.log('--- 1. Obteniendo token OAuth2 ---');
  const oauthUrl = `https://api-seguridad.sunat.gob.pe/v1/clientessol/${clientId}/oauth2/token`;
  const bodyToken = new URLSearchParams({
    grant_type: 'password',
    scope: 'https://api-sire.sunat.gob.pe',
    client_id: clientId,
    client_secret: clientSecret,
    username: `${ruc}${usuarioSol}`,
    password: claveSol,
  });
  const respToken = await fetch(oauthUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: bodyToken.toString() });
  const dataToken = await respToken.json();
  if (!respToken.ok || !dataToken.access_token) { console.error('Token FALLÓ', respToken.status, dataToken); process.exit(1); }
  const token = dataToken.access_token;
  console.log('Token OK');

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' };

  console.log('--- 2. Generando ticket RVIE para periodo', periodo, '---');
  const urlTicket = `https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvie/propuesta/web/propuesta/${periodo}/exportapropuesta?codTipoArchivo=0`;
  const respTicket = await fetch(urlTicket, { headers });
  const dataTicket = await respTicket.json().catch(() => null);
  console.log('status', respTicket.status, JSON.stringify(dataTicket));
  const ticket = dataTicket?.numTicket || dataTicket?.ticket;
  if (!ticket) { console.error('No se obtuvo ticket'); process.exit(1); }
  console.log('Ticket generado:', ticket);

  console.log('--- 3. Consultando estado (reintentos cada 5s, hasta 60s) ---');
  let intentos = 0;
  let detalle, match;
  while (intentos < 12) {
    await new Promise((r) => setTimeout(r, 5000));
    const urlEstado = `https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets?perIni=${periodo}&perFin=${periodo}&page=1&perPage=20&numTicket=${ticket}`;
    const respEstado = await fetch(urlEstado, { headers });
    const dataEstado = await respEstado.json().catch(() => null);
    const registros = dataEstado?.registros || [];
    match = registros.find((r) => String(r?.detalleTicket?.numTicket) === String(ticket));
    detalle = match?.detalleTicket;
    console.log(`Intento ${intentos + 1}: estado =`, detalle?.desEstadoEnvio);
    if (String(detalle?.desEstadoEnvio || '').toUpperCase().includes('TERMINADO') || String(detalle?.desEstadoEnvio || '').toUpperCase().includes('CONCLUIDO')) break;
    if (String(detalle?.desEstadoEnvio || '').toUpperCase().includes('ERROR')) { console.error('SUNAT devolvió ERROR', detalle); process.exit(1); }
    intentos++;
  }
  if (!detalle) { console.error('No se pudo confirmar estado del ticket'); process.exit(1); }

  const archivoReporte = match?.archivoReporte?.[0];
  const nombreArchivo = archivoReporte?.nomArchivoReporte || detalle?.nomArchivoReporte;
  const codTipoArchivoReporte = archivoReporte?.codTipoAchivoReporte ?? null;
  const codProceso = match?.codProceso ?? null;
  console.log('nombreArchivo:', nombreArchivo, '| codTipoArchivoReporte:', codTipoArchivoReporte, '| codProceso:', codProceso);
  if (!nombreArchivo || !codProceso) { console.error('Faltan datos para descargar el archivo'); process.exit(1); }

  console.log('--- 4. Descargando archivo ---');
  const urlDescarga = `https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte?nomArchivoReporte=${encodeURIComponent(nombreArchivo)}&codTipoArchivoReporte=${codTipoArchivoReporte ?? 'null'}&perTributario=${periodo}&codProceso=${codProceso}&numTicket=${ticket}`;
  const respArchivo = await fetch(urlDescarga, { headers });
  console.log('status descarga:', respArchivo.status);
  if (!respArchivo.ok) {
    const cuerpo = await respArchivo.json().catch(() => null);
    console.error('Descarga FALLÓ', cuerpo);
    process.exit(1);
  }
  const buffer = Buffer.from(await respArchivo.arrayBuffer());
  const fs = require('fs');
  const path = require('path');
  const rutaSalida = path.join(process.cwd(), 'storage-privado', 'debug-sire', 'sire-test-descarga.zip');
  fs.mkdirSync(path.dirname(rutaSalida), { recursive: true });
  fs.writeFileSync(rutaSalida, buffer);
  console.log('Archivo guardado:', rutaSalida, '(', buffer.length, 'bytes )');
  console.log('=== ÉXITO: flujo completo SIRE confirmado contra SUNAT real ===');
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });

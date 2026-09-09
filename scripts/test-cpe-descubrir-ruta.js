// PROBE 3: descubrir la ruta real del servicio CPE en api-cpe.sunat.gob.pe.
//
// El probe 2 dio 404 en /v1/comprobante/... pero con el cuerpo genérico del gateway
// ({"status":404,"message":"Resource not found"}), no un error de negocio. Eso indica
// ruta inexistente, no comprobante inexistente.
//
// MÉTODO (el mismo que se usó para descubrir los endpoints del SIRE, ver los
// comentarios de sire.service.ts): el gateway de SUNAT responde distinto según el
// caso, y esa diferencia es la señal:
//   404 "Resource not found"  → la ruta NO existe en el gateway
//   401 / 403                 → la ruta EXISTE, falta permiso/recurso habilitado
//   400 / 422                 → la ruta EXISTE, faltan o sobran parámetros
//   200                       → la ruta existe y responde
// Cualquier cosa que NO sea 404 genérico es un acierto y define por dónde seguir.
//
// Uso: node test-cpe-descubrir-ruta.js <RUC_CONSULTANTE>
require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');

// Comprobante real de storage-privado/sire/RCE_202602_7.zip (compra de RG TRANSPORTES).
const C = { rucEmisor: '20477484531', tipo: '01', serie: 'F011', correlativo: '78118' };

// Candidatos ordenados por probabilidad. "consultacpe" aparece en la documentación
// de terceros como el nombre del RECURSO a habilitar en SOL, así que es el segmento
// más probable de la ruta.
const RUTAS = [
  // Sondas de prefijo: sin parámetros, solo para ver qué conoce el gateway.
  '/v1/contribuyente/consultacpe',
  '/v1/consultacpe',
  '/v1/contribuyente/comprobante',
  // Rutas completas con parámetros.
  `/v1/contribuyente/consultacpe/${C.rucEmisor}/${C.tipo}/${C.serie}/${C.correlativo}/1`,
  `/v1/contribuyente/consultacpe/comprobantes/${C.rucEmisor}/${C.tipo}/${C.serie}/${C.correlativo}/1`,
  `/v1/consultacpe/${C.rucEmisor}/${C.tipo}/${C.serie}/${C.correlativo}/1`,
  `/v1/contribuyente/comprobante/${C.rucEmisor}/${C.tipo}/${C.serie}/${C.correlativo}/1`,
  `/v1/comprobante/${C.rucEmisor}/${C.tipo}/${C.serie}/${C.correlativo}`,
  `/v1/contribuyente/cpe/${C.rucEmisor}/${C.tipo}/${C.serie}/${C.correlativo}/1`,
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
  const ruc = process.argv[2];
  if (!ruc) { console.error('Uso: node test-cpe-descubrir-ruta.js <RUC>'); process.exit(1); }

  const key = process.env.CREDENCIALES_ENCRYPTION_KEY;
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
  });
  const [[e]] = await conn.query(
    `SELECT ruc, sunat_sol_usuario, sunat_sol_password, sunat_api_client_id, sunat_api_client_secret
       FROM empresa WHERE ruc = ?`, [ruc]);
  await conn.end();
  if (!e || !e.sunat_api_client_id) { console.error('Empresa sin credenciales de API'); process.exit(1); }

  const usuarioSol = descifrar(e.sunat_sol_usuario, key).trim();
  const claveSol = descifrar(e.sunat_sol_password, key).trim();
  const clientId = descifrar(e.sunat_api_client_id, key).trim();
  const clientSecret = descifrar(e.sunat_api_client_secret, key).trim();

  const body = new URLSearchParams({
    grant_type: 'password', scope: 'https://api-cpe.sunat.gob.pe',
    client_id: clientId, client_secret: clientSecret,
    username: `${ruc}${usuarioSol}`, password: claveSol,
  });
  const rt = await fetch(`https://api-seguridad.sunat.gob.pe/v1/clientessol/${clientId}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  const dt = await rt.json().catch(() => null);
  if (!rt.ok || !dt?.access_token) { console.error('Token FALLÓ', rt.status, dt); process.exit(1); }
  console.log('Token OK — barriendo rutas en api-cpe.sunat.gob.pe\n');

  const aciertos = [];
  for (const ruta of RUTAS) {
    const url = `https://api-cpe.sunat.gob.pe${ruta}`;
    try {
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${dt.access_token}`, Accept: 'application/json' } });
      const texto = (await resp.text()).slice(0, 200).replace(/\s+/g, ' ');
      const genérico404 = resp.status === 404 && /Resource not found/i.test(texto);
      const marca = genérico404 ? '   ' : '>>>';
      console.log(`${marca} ${resp.status}  ${ruta}`);
      if (!genérico404) {
        console.log(`      ${texto}`);
        aciertos.push({ ruta, status: resp.status, texto });
      }
    } catch (err) {
      console.log(`    ERR  ${ruta} — ${err.message}`);
    }
    await dormir(1500);
  }

  console.log('\n================ RESUMEN ================');
  if (!aciertos.length) {
    console.log('Todas dieron 404 genérico: el servicio NO se expone por api-cpe con estas rutas.');
    console.log('Siguiente vía a probar: el portal SOL con Playwright (ya existe login funcionando).');
  } else {
    console.log('Rutas que el gateway SÍ reconoce (seguir por acá):');
    aciertos.forEach((a) => console.log(`  ${a.status}  ${a.ruta}\n      ${a.texto}`));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

// ETAPA 3 — usar el token DEL PORTAL contra api-cpe.
//
// Hallazgo de la etapa 2: al abrir la opción 11.38.1.1.1 ("Nueva Consulta de
// comprobantes de pago"), SOL redirige al loader de la SPA pasándole un JWT en la
// query string. Ese JWT trae en su claim `aud`:
//
//   [{"api":"https://api-cpe.sunat.gob.pe","recurso":[
//      {"id":"/v1/contribuyente/consultacpe", ...},
//      {"id":"/v1/contribuyente/parametros",  ...}]}]
//
// O sea: la ruta base ES /v1/contribuyente/consultacpe. Cuando la probamos antes y
// dio 404 no era que la ruta no existiera — era que nuestro token (grant_type
// password, client_id propio) NO la lleva en su `aud`, y el gateway responde 404 en
// vez de 403 para no filtrar qué rutas existen.
//
// Este token, en cambio, sí la lleva: lo emite el client_id del propio portal
// (cd8e7afb-...) con grantType=authorization_token. Dura 1 hora.
//
// El loader de la SPA devuelve 404 (URL desactualizada en el menú de SUNAT), así que
// la SPA nunca arranca y no podemos espiar sus llamadas. Pero con el token en mano no
// hace falta: se le pega directo a la API.
//
// Uso: node test-cpe-con-token-portal.js [RUC]
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const RUC = process.argv[2] || '20539814452';
// Comprobante real del RCE ya descargado (compra a ESTACION DE SERVICIOS AVE FENIX).
const C = { rucEmisor: '20477484531', tipo: '01', serie: 'F011', correlativo: '78118' };
const BASE = 'https://api-cpe.sunat.gob.pe';

const RUTAS = [
  // Sondas: ¿qué reconoce el gateway ahora que el token sí trae el recurso?
  '/v1/contribuyente/consultacpe',
  '/v1/contribuyente/parametros',
  // Con el comprobante, en las formas más probables.
  `/v1/contribuyente/consultacpe/${C.rucEmisor}/${C.tipo}/${C.serie}/${C.correlativo}`,
  `/v1/contribuyente/consultacpe/${C.rucEmisor}/${C.tipo}/${C.serie}/${C.correlativo}/1`,
  `/v1/contribuyente/consultacpe/${C.rucEmisor}/${C.tipo}/${C.serie}/${C.correlativo}/1/02`,
  `/v1/contribuyente/consultacpe/comprobantes/${C.rucEmisor}/${C.tipo}/${C.serie}/${C.correlativo}/1`,
  // Consultas de listado (lo que realmente queremos: los comprobantes de un período).
  `/v1/contribuyente/consultacpe/${RUC}/comprobantes`,
  '/v1/contribuyente/consultacpe/consulta',
  '/v1/contribuyente/consultacpe/recibidos',
];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const archivo = path.join(process.cwd(), 'storage-privado', 'debug-cpe', `token-portal-${RUC}.txt`);
  if (!fs.existsSync(archivo)) {
    console.error(`No existe ${archivo}. Corré primero: node scripts/explorar-modulo-cpe.js ${RUC}`);
    process.exit(1);
  }
  const token = fs.readFileSync(archivo, 'utf8').trim();

  // El token dura 1h. Si venció, todo va a dar 401 y hay que volver a capturarlo —
  // conviene avisarlo ANTES de que parezca que las rutas están mal.
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
  const quedan = payload.exp - Math.floor(Date.now() / 1000);
  console.log(`Token de ${payload.sub} — vence en ${Math.round(quedan / 60)} min`);
  if (quedan <= 0) {
    console.error('TOKEN VENCIDO. Volvé a correr explorar-modulo-cpe.js para capturar uno nuevo.');
    process.exit(1);
  }
  console.log('Recursos autorizados:', payload.aud, '\n');

  const aciertos = [];
  for (const ruta of RUTAS) {
    try {
      const resp = await fetch(BASE + ruta, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const texto = (await resp.text()).slice(0, 400).replace(/\s+/g, ' ');
      const gen404 = resp.status === 404 && /Resource not found/i.test(texto);
      console.log(`${gen404 ? '   ' : '>>>'} ${resp.status}  ${ruta}`);
      if (!gen404) {
        console.log(`      ${texto}`);
        aciertos.push({ ruta, status: resp.status });
      }
    } catch (e) {
      console.log(`  ERR  ${ruta} — ${e.message}`);
    }
    await dormir(1200);
  }

  console.log('\n================ RESUMEN ================');
  if (!aciertos.length) {
    console.log('Todo 404 genérico incluso con el token del portal.');
    console.log('=> La ruta lleva segmentos que todavía no adivinamos. Siguiente vía:');
    console.log('   arreglar la URL del loader de la SPA para verla llamar de verdad.');
  } else {
    aciertos.forEach((a) => console.log(`  ${a.status}  ${a.ruta}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

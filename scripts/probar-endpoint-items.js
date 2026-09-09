// Prueba de punta a punta del endpoint de detalle de ítems contra el backend real.
// Firma un JWT en vez de hacer login (no toca la tabla de usuarios); el rol 1 tiene
// bypass en PermissionsGuard.
//
// Uso: node probar-endpoint-items.js <RUC> <PERIODO_AAAAMM> [PUERTO]
require('dotenv').config();
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

async function main() {
  const ruc = process.argv[2] || '20539814452';
  const periodo = process.argv[3] || '202602';
  const puerto = process.argv[4] || '4033';
  const base = `http://localhost:${puerto}/api/vencimientos/sire`;

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
  });
  const [[emp]] = await conn.query('SELECT id_empresa, razon_social FROM empresa WHERE ruc = ?', [ruc]);
  if (!emp) { console.error('Empresa no encontrada'); process.exit(1); }

  const token = jwt.sign(
    { sub: 1, username: 'admin@gmail.com', roleId: 1 },
    process.env.JWT_SECRET,
    { expiresIn: '4h' },
  );
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  console.log(`Empresa: ${emp.razon_social} (id ${emp.id_empresa}) — período ${periodo}\n`);

  console.log('--- POST descargas/sincronizar-items ---');
  const r = await fetch(`${base}/descargas/sincronizar-items`, {
    method: 'POST', headers,
    body: JSON.stringify({ id_empresa: emp.id_empresa, periodo }),
  });
  const cuerpo = await r.text();
  console.log(`status ${r.status}`);
  console.log(cuerpo.slice(0, 900));

  // Se lee de la BD y no del endpoint de detalle: eso exige una descarga SIRE previa
  // del mismo período, y acá lo que se valida es que el guardado haya quedado bien.
  const [filas] = await conn.query(
    `SELECT serie, numero, nro_linea, descripcion, cantidad, unidad_medida, precio_unitario, importe
       FROM sire_comprobante_item WHERE id_empresa = ? ORDER BY serie, numero, nro_linea LIMIT 15`,
    [emp.id_empresa],
  );
  console.log(`\n--- Guardado en BD: ${filas.length} fila(s) de muestra ---`);
  filas.forEach((f) => console.log(
    `  ${f.serie}-${f.numero} #${f.nro_linea} | ${f.descripcion.slice(0, 60)} | ` +
    `${f.cantidad} ${f.unidad_medida || ''} x ${f.precio_unitario} = ${f.importe}`,
  ));
  await conn.end();
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });

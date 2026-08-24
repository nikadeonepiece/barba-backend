/**
 * UN SOLO COMANDO para dejar la base de datos lista de punta a punta:
 *   1. Corre bd.sql completo (DROP + CREATE de ESTUDIOBARBA, todas las tablas,
 *      stored procedures, permisos y las 171 empresas base — sin credenciales).
 *   2. Corre migrar-credenciales-sunat.js (carga la Clave SOL de las 171
 *      empresas, cifrada con la CREDENCIALES_ENCRYPTION_KEY de este .env).
 *
 * Por qué sigue siendo "2 SQLs" por dentro y no un solo bd.sql con todo:
 * el paso 2 cifra en el momento de correr, con la llave de ESTE ambiente. Si
 * las credenciales ya cifradas quedaran escritas dentro de bd.sql, en otro
 * ambiente (otra CREDENCIALES_ENCRYPTION_KEY, ej. la nube) se leerían como
 * basura indescifrable — por eso el cifrado no puede ser un dato estático del
 * archivo, tiene que calcularse cada vez que se corre. Este script solo une
 * los dos pasos en un solo comando para que no haya que acordarse de nada.
 *
 * Uso (desde erp-backend/):
 *   node scripts/reset-bd-completo.js
 *
 * Requiere: el cliente `mysql` en el PATH, o mysql.exe de Laragon en su
 * ubicación default (se detecta solo). DB_* y CREDENCIALES_ENCRYPTION_KEY
 * deben estar en el .env de erp-backend/.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function ubicarMysqlCli() {
  const candidatos = [
    'mysql', // si ya está en el PATH
    'C:\\laragon\\bin\\mysql\\mysql-8.4.3-winx64\\bin\\mysql.exe',
  ];
  for (const c of candidatos) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore', shell: false });
    if (!r.error) return c;
  }
  // Último intento: buscar cualquier mysql-*/bin/mysql.exe dentro de laragon/bin/mysql
  const baseLaragon = 'C:\\laragon\\bin\\mysql';
  if (fs.existsSync(baseLaragon)) {
    const carpeta = fs.readdirSync(baseLaragon).find((n) => n.startsWith('mysql-'));
    if (carpeta) {
      const ruta = path.join(baseLaragon, carpeta, 'bin', 'mysql.exe');
      if (fs.existsSync(ruta)) return ruta;
    }
  }
  return null;
}

function correrBdSql(mysqlCli) {
  // bd.sql vive en erp-backend/ (fuente única del esquema; ya no hay migraciones
  // sueltas en bd/, esa carpeta quedó solo con documentación).
  const bdSqlPath = path.join(__dirname, '..', 'bd.sql');
  console.log(`[1/2] Corriendo bd.sql (${bdSqlPath})...`);
  const sql = fs.readFileSync(bdSqlPath, 'utf8');
  const args = ['-h', process.env.DB_HOST || 'localhost', '-P', String(process.env.DB_PORT || 3306), '-u', process.env.DB_USER || 'root'];
  if (process.env.DB_PASSWORD) args.push(`-p${process.env.DB_PASSWORD}`);
  const r = spawnSync(mysqlCli, args, { input: sql, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error('bd.sql falló — revisa el mensaje de MySQL arriba.');
  console.log('[1/2] bd.sql OK.');
}

function correrMigracionCredenciales() {
  console.log('[2/2] Cargando credenciales SUNAT...');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'migrar-credenciales-sunat.js')], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('La migración de credenciales falló — revisa el mensaje arriba.');
  console.log('[2/2] Credenciales OK.');
}

try {
  const mysqlCli = ubicarMysqlCli();
  if (!mysqlCli) {
    console.error('No encontré el cliente `mysql`. Instálalo o corre bd.sql manualmente y luego solo:\n  node scripts/migrar-credenciales-sunat.js');
    process.exit(1);
  }
  correrBdSql(mysqlCli);
  correrMigracionCredenciales();
  console.log('\nListo — base de datos, empresas y credenciales SUNAT cargadas.');
} catch (e) {
  console.error('\nERROR:', e.message);
  process.exit(1);
}

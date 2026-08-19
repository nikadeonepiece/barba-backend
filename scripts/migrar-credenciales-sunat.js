/**
 * Migración de las credenciales SUNAT (Clave SOL) reales del Excel del estudio
 * hacia la tabla `empresa`, cifradas con el mismo algoritmo que usa la
 * aplicación (AES-256-GCM, CredencialesCryptoService).
 *
 * Por qué existe este script aparte y no un INSERT en bd.sql:
 * las credenciales SUNAT de ~170 empresas reales NUNCA deben quedar en texto
 * plano (ni cifradas) en un archivo SQL versionado — un valor cifrado con la
 * CREDENCIALES_ENCRYPTION_KEY de un ambiente es basura ilegible en otro. Se
 * cifran en el momento de correr este script, con la llave del .env del
 * ambiente donde se está corriendo.
 *
 * Cuándo correrlo: SIEMPRE después de (re)correr bd.sql — bd.sql hace
 * `DROP TABLE empresa` y la vuelve a poblar sin credenciales (a propósito).
 * Este script es el paso 2 obligatorio para que las 171 empresas queden con
 * su Clave SOL real, igual que estaban en el Excel.
 *
 * Uso (desde erp-backend/):
 *   1. Correr primero bd.sql completo (crea/repuebla la tabla `empresa`).
 *   2. Tener el .env de erp-backend con DB_* y CREDENCIALES_ENCRYPTION_KEY configurados.
 *   3. node scripts/migrar-credenciales-sunat.js
 *      (por defecto lee "../bd/Control de Vencimientos_EBA.xlsm" — pasar una
 *      ruta como argumento si el Excel está en otro lugar)
 *
 * Solo carga Usuario/Clave SOL (hoja "CLIENTES", columnas F y G) — los
 * campos de API SUNAT (client_id/secret) no están en el Excel y se cargan
 * aparte, manualmente, desde el modal "Credenciales SUNAT" de Empresas.
 */
require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const mysql = require('mysql2/promise');
const { createCipheriv, randomBytes } = require('crypto');

function cifrar(key, textoPlano) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

async function main() {
  const excelPath = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'bd', 'Control de Vencimientos_EBA.xlsm'));

  if (!process.env.CREDENCIALES_ENCRYPTION_KEY) {
    console.error('Falta CREDENCIALES_ENCRYPTION_KEY en el .env');
    process.exit(1);
  }
  const key = Buffer.from(process.env.CREDENCIALES_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    console.error('CREDENCIALES_ENCRYPTION_KEY debe decodificar a 32 bytes exactos');
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelPath);
  const sheet = wb.getWorksheet('CLIENTES');
  if (!sheet) {
    console.error(`No se encontró la hoja "CLIENTES" en ${excelPath}`);
    process.exit(1);
  }

  // Fila 8 es el encabezado real (título+filtros ocupan las filas 1-7); columnas
  // fijas de la plantilla: B=Razón Social, C=RUC, F=Usuario SOL, G=Clave SOL.
  const registros = [];
  for (let r = 9; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const ruc = row.getCell(3).value;
    const usuario = row.getCell(6).value;
    const clave = row.getCell(7).value;
    if (!ruc) continue;
    registros.push({
      ruc: String(ruc).trim(),
      solUsuario: usuario ? String(usuario).trim() : null,
      solPassword: clave ? String(clave).trim() : null,
    });
  }

  console.log(`Leídas ${registros.length} filas de "${excelPath}". Migrando...`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  let ok = 0, sinEmpresa = 0, sinCredencial = 0;
  for (const r of registros) {
    if (!r.solUsuario || !r.solPassword) { sinCredencial++; continue; }
    const [empresas] = await conn.query('SELECT id_empresa FROM empresa WHERE ruc = ?', [r.ruc]);
    if (empresas.length === 0) {
      console.warn(`  RUC ${r.ruc} no existe en la tabla empresa todavía — ¿corriste bd.sql primero?`);
      sinEmpresa++;
      continue;
    }
    const idEmpresa = empresas[0].id_empresa;
    const usuarioCifrado = cifrar(key, r.solUsuario);
    const passwordCifrado = cifrar(key, r.solPassword);
    await conn.query('CALL empresa_credenciales_guardar(?, ?, ?, NULL, NULL)', [idEmpresa, usuarioCifrado, passwordCifrado]);
    ok++;
  }

  await conn.end();
  console.log(`Listo. ${ok} empresas actualizadas con Clave SOL cifrada. ${sinCredencial} sin usuario/clave en el Excel. ${sinEmpresa} sin coincidencia de RUC en la BD.`);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });

/**
 * Genera la semilla SQL de `planilla_sunat_catalogo` a partir del Anexo 2 de
 * SUNAT: todas las tablas paramétricas MENOS la 22, que vive en su propia tabla
 * (`planilla_concepto`, ver generar-seed-conceptos-plame.js).
 *
 * Por qué la configuración es explícita y no auto-detectada:
 * las 30 hojas no comparten estructura. El encabezado está en la fila 1, 3, 4, 5
 * o 6 según la hoja; unas traen "DESCRIPCIÓN ABREVIADA" y otras no; la T14 mete
 * el RUC en la columna 2; la T21 pone la abreviada en la columna 5. Auto-detectar
 * eso funciona hasta que SUNAT mueve una columna y el mapeo se corrompe EN
 * SILENCIO, cargando descripciones en el campo equivocado. Con el mapa explícito,
 * un cambio de formato revienta ruidosamente y se corrige acá.
 *
 * Uso:
 *   node scripts/generar-seed-catalogos-sunat.js
 *
 * Entrada: bd/sunat-tablas-parametricas/tablas_2026.xlsx
 * Salida:  erp-backend/bd.sql — reemplaza el bloque marcado 'planilla_sunat_catalogo'
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const DIR_TABLAS = path.resolve(__dirname, '..', '..', 'bd', 'sunat-tablas-parametricas');
const ARCHIVO_ENTRADA = path.join(DIR_TABLAS, 'tablas_2026.xlsx');
const { reemplazarBloque } = require('./lib/splice-bd-sql');

const BLOQUE = 'planilla_sunat_catalogo';

/**
 * num       = número de tabla del Anexo 2
 * hoja      = nombre EXACTO de la hoja (ojo con los espacios finales)
 * nombre    = etiqueta legible que se guarda en tabla_nombre
 * filaInicio= primera fila con datos (la siguiente al encabezado)
 * codigo/descripcion/abreviada = índice de columna (1-based, como ExcelJS)
 * privado/publico = columnas 'A'/'N.A' de aplicabilidad por sector, si existen
 * padCodigo = a cuántos dígitos rellenar con ceros ('2' -> '02'); 0 = dejar tal cual
 */
const TABLAS = [
  { num: 1,  hoja: 'T1 Actividad',                 nombre: 'Tipo de actividad (CIIU)',                 filaInicio: 4,  codigo: 1, descripcion: 2, padCodigo: 0 },
  { num: 3,  hoja: 'T3- Tipo Documento',           nombre: 'Tipo de documento de identidad',           filaInicio: 4,  codigo: 1, descripcion: 2, abreviada: 6, padCodigo: 2 },
  { num: 4,  hoja: 'T4 Nacionalidad',              nombre: 'Nacionalidad',                             filaInicio: 4,  codigo: 1, descripcion: 2, padCodigo: 0 },
  { num: 5,  hoja: 'T5 Via',                       nombre: 'Vía',                                      filaInicio: 4,  codigo: 1, descripcion: 2, padCodigo: 2 },
  { num: 6,  hoja: 'T6 Zona',                      nombre: 'Zona',                                     filaInicio: 4,  codigo: 1, descripcion: 2, padCodigo: 2 },
  { num: 8,  hoja: 'T8 Tipo Trab-Pens-PS',         nombre: 'Tipo de trabajador, pensionista o prestador de servicios', filaInicio: 4, codigo: 1, descripcion: 2, abreviada: 3, privado: 4, publico: 5, padCodigo: 2 },
  { num: 9,  hoja: 'T9 Situación Educativa',       nombre: 'Situación educativa',                      filaInicio: 4,  codigo: 1, descripcion: 2, abreviada: 3, padCodigo: 2 },
  { num: 11, hoja: 'T11 Reg. Pensionario',         nombre: 'Régimen pensionario',                      filaInicio: 4,  codigo: 1, descripcion: 2, abreviada: 3, privado: 4, publico: 5, padCodigo: 2 },
  { num: 12, hoja: 'T12 Contratos',                nombre: 'Tipo de contrato de trabajo',              filaInicio: 4,  codigo: 1, descripcion: 2, abreviada: 3, padCodigo: 2 },
  { num: 13, hoja: 'T13 Periodicidad',             nombre: 'Periodicidad de la remuneración',          filaInicio: 4,  codigo: 1, descripcion: 2, padCodigo: 2 },
  { num: 14, hoja: 'T14 EPSSERV PROPIOS',          nombre: 'EPS / servicios propios',                  filaInicio: 4,  codigo: 1, descripcion: 3, abreviada: 2, padCodigo: 2 },
  { num: 15, hoja: 'T15 Situación ',               nombre: 'Situación del trabajador o pensionista',   filaInicio: 5,  codigo: 1, descripcion: 2, abreviada: 3, padCodigo: 2 },
  { num: 16, hoja: 'T16 Tipo de Pago',             nombre: 'Tipo de pago',                             filaInicio: 4,  codigo: 1, descripcion: 2, padCodigo: 2 },
  { num: 17, hoja: 'T17 Motivo fin del periodo',   nombre: 'Motivo del fin del período',               filaInicio: 4,  codigo: 1, descripcion: 2, abreviada: 3, padCodigo: 2 },
  { num: 18, hoja: 'T18 Tipo Modalidad Formativa', nombre: 'Tipo de modalidad formativa',              filaInicio: 4,  codigo: 1, descripcion: 2, abreviada: 3, padCodigo: 2 },
  { num: 19, hoja: 'T19 Vínculo familiar',         nombre: 'Vínculo familiar',                         filaInicio: 4,  codigo: 1, descripcion: 2, abreviada: 3, padCodigo: 2 },
  { num: 20, hoja: 'T20 Motivo Baja DH',           nombre: 'Motivo de baja como derechohabiente',      filaInicio: 5,  codigo: 1, descripcion: 2, abreviada: 3, padCodigo: 2 },
  { num: 21, hoja: 'T21 Tipo Suspensión',          nombre: 'Tipo de suspensión de la relación laboral', filaInicio: 4, codigo: 1, descripcion: 2, abreviada: 5, padCodigo: 2 },
  { num: 23, hoja: 'T23 Tipo Comprobante',         nombre: 'Tipo de comprobante',                      filaInicio: 6,  codigo: 1, descripcion: 2, padCodigo: 0 },
  { num: 24, hoja: 'T24 Categoria Ocupacional',    nombre: 'Categoría ocupacional del trabajador',     filaInicio: 5,  codigo: 1, descripcion: 2, privado: 3, publico: 4, padCodigo: 2 },
  { num: 25, hoja: 'T25 Convenios',                nombre: 'Convenios para evitar la doble tributación', filaInicio: 4, codigo: 1, descripcion: 2, padCodigo: 2 },
  { num: 26, hoja: 'T26 País Emisor Dcto',         nombre: 'País emisor del documento',                filaInicio: 4,  codigo: 1, descripcion: 2, padCodigo: 0 },
  { num: 27, hoja: 'T27 Acredita Vinc. Fam',       nombre: 'Documento que acredita el vínculo familiar', filaInicio: 4, codigo: 1, descripcion: 2, abreviada: 3, padCodigo: 2 },
  { num: 29, hoja: 'T29 Cod LDN',                  nombre: 'Código LDN',                               filaInicio: 4,  codigo: 1, descripcion: 2, padCodigo: 0 },
  { num: 30, hoja: 'T30 Ocupación S.Privado',      nombre: 'Ocupación (sector privado)',               filaInicio: 7,  codigo: 1, descripcion: 2, padCodigo: 0 },
  { num: 32, hoja: 'T32 Rég Aseg Salud',           nombre: 'Régimen de aseguramiento en salud',        filaInicio: 5,  codigo: 1, descripcion: 2, abreviada: 3, padCodigo: 2 },
  { num: 33, hoja: 'T33 Régimen Laboral',          nombre: 'Régimen laboral',                          filaInicio: 4,  codigo: 1, descripcion: 2, abreviada: 3, privado: 4, publico: 5, padCodigo: 2 },
  { num: 35, hoja: 'T35 Situacion especial',       nombre: 'Situación especial',                       filaInicio: 4,  codigo: 1, descripcion: 2, abreviada: 3, padCodigo: 2 },
  { num: 36, hoja: 'T36 Entidad Bancaria',         nombre: 'Entidad del sistema financiero',           filaInicio: 4,  codigo: 1, descripcion: 2, padCodigo: 3 },
];

// La T28 va aparte: NO es una tabla, son TRES listas independientes puestas en
// columnas paralelas (departamento / provincia / distrito). Las filas no se
// corresponden entre sí — en la fila 7 el departamento es ÁNCASH pero la
// provincia es BAGUA, que pertenece a Amazonas. Leerla como una sola tabla
// produce datos cruzados y silenciosamente falsos.
// Se cargan las tres en tabla_num=28: la longitud del código dice el nivel
// (2 = departamento, 4 = provincia, 6 = distrito), que es como funciona el ubigeo.
const UBIGEO = {
  num: 28,
  hoja: 'T28 UBIGEO',
  nombre: 'Ubigeo RENIEC',
  filaInicio: 6,
  niveles: [
    { codigo: 1, descripcion: 2, pad: 2 },
    { codigo: 3, descripcion: 4, pad: 4 },
    { codigo: 5, descripcion: 6, pad: 6 },
  ],
};

// Se omiten a propósito (el estudio lleva empresas del sector privado):
//   T10  Ocupación sector público          (4 755 filas)
//   T31  Pliego presupuestal               (solo sector público)
//   T34  Instituciones educativas/carreras (5 935 filas, solo modalidad formativa)
//   T37  Organizaciones sindicales S.Púb.  (5 263 filas)
//   TM B No es un catálogo: es la matriz de qué campos son obligatorios por tipo
//   T22  Ya vive en planilla_concepto

const texto = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.richText) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && v.text) return String(v.text);
  if (typeof v === 'object' && v.result !== undefined) return String(v.result);
  return String(v);
};
const limpiar = (v) => texto(v).replace(/\s+/g, ' ').trim();
const escapar = (s) => s.replace(/'/g, "''");

// SUNAT marca aplicabilidad con 'A' (aplica) / 'N.A' (no aplica), y en la T3 con 'X'.
const aplica = (v) => {
  const s = limpiar(v).toUpperCase();
  if (!s) return 1;
  if (s === 'N.A' || s === 'NA' || s === 'NO') return 0;
  return 1;
};

// SUNAT no borra códigos: los deja con una nota "Deshabilitado el dd.mm.aaaa".
const estaDeshabilitado = (fila) => {
  let hallado = false;
  fila.eachCell({ includeEmpty: false }, (c) => {
    if (/deshabilitad/i.test(limpiar(c.value))) hallado = true;
  });
  return hallado;
};

async function main() {
  if (!fs.existsSync(ARCHIVO_ENTRADA)) throw new Error(`No existe: ${ARCHIVO_ENTRADA}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(ARCHIVO_ENTRADA);

  const filas = [];
  const resumen = [];

  const agregar = (cfg, codigo, descripcion, abreviada, priv, pub, vigente) => {
    filas.push(
      `(${cfg.num},'${escapar(cfg.nombre)}','${escapar(codigo)}','${escapar(descripcion)}',` +
        `${abreviada ? `'${escapar(abreviada)}'` : 'NULL'},${priv},${pub},${vigente},1)`,
    );
  };

  for (const cfg of TABLAS) {
    const ws = workbook.getWorksheet(cfg.hoja);
    if (!ws) throw new Error(`Falta la hoja ${JSON.stringify(cfg.hoja)} — ¿SUNAT la renombró?`);

    const vistos = new Set();
    let cargadas = 0;

    ws.eachRow((fila, n) => {
      if (n < cfg.filaInicio) return;

      let codigo = limpiar(fila.getCell(cfg.codigo).value);
      const descripcion = limpiar(fila.getCell(cfg.descripcion).value);

      // Filas de notas al pie, encabezados repetidos y separadores.
      if (!codigo || !descripcion) return;
      if (!/^[0-9A-Za-z.\-]{1,10}$/.test(codigo)) return;
      if (/^(CÓDIGO|CODIGO|N°|DESCRIPCI)/i.test(codigo)) return;

      if (cfg.padCodigo && /^\d+$/.test(codigo)) codigo = codigo.padStart(cfg.padCodigo, '0');
      if (vistos.has(codigo)) return; // la T4 y la T26 repiten algún código en notas
      vistos.add(codigo);

      const abreviada = cfg.abreviada ? limpiar(fila.getCell(cfg.abreviada).value) : '';
      const priv = cfg.privado ? aplica(fila.getCell(cfg.privado).value) : 1;
      const pub = cfg.publico ? aplica(fila.getCell(cfg.publico).value) : 1;
      const vigente = estaDeshabilitado(fila) ? 0 : 1;

      agregar(cfg, codigo, descripcion, abreviada, priv, pub, vigente);
      cargadas++;
    });

    if (!cargadas) throw new Error(`La hoja ${JSON.stringify(cfg.hoja)} no produjo ninguna fila — revisar filaInicio/columnas`);
    resumen.push({ num: cfg.num, nombre: cfg.nombre, filas: cargadas });
  }

  // T28 UBIGEO — tres listas independientes.
  {
    const ws = workbook.getWorksheet(UBIGEO.hoja);
    if (!ws) throw new Error(`Falta la hoja ${JSON.stringify(UBIGEO.hoja)}`);
    const vistos = new Set();
    let cargadas = 0;

    ws.eachRow((fila, n) => {
      if (n < UBIGEO.filaInicio) return;
      for (const nivel of UBIGEO.niveles) {
        let codigo = limpiar(fila.getCell(nivel.codigo).value);
        const descripcion = limpiar(fila.getCell(nivel.descripcion).value);
        if (!codigo || !descripcion) continue;
        if (!/^\d+$/.test(codigo)) continue;
        codigo = codigo.padStart(nivel.pad, '0');
        if (codigo.length !== nivel.pad) continue;
        if (vistos.has(codigo)) continue;
        vistos.add(codigo);
        agregar(UBIGEO, codigo, descripcion, '', 1, 1, 1);
        cargadas++;
      }
    });
    if (!cargadas) throw new Error('La hoja de UBIGEO no produjo ninguna fila');
    resumen.push({ num: UBIGEO.num, nombre: UBIGEO.nombre, filas: cargadas });
  }

  const detalle = resumen
    .sort((a, b) => a.num - b.num)
    .map((r) => `--   T${String(r.num).padStart(2)}  ${String(r.filas).padStart(5)} filas   ${r.nombre}`)
    .join('\n');

  const sql = `-- ==============================================================================
-- Semilla planilla_sunat_catalogo — Anexo 2 de SUNAT (tablas paramétricas)
--
-- GENERADO — no editar a mano. Re-correr:
--   node scripts/generar-seed-catalogos-sunat.js
--
-- Fuente oficial: bd/sunat-tablas-parametricas/tablas_2026.xlsx
--                 https://orientacion.sunat.gob.pe/7086-12-tablas-parametricas
--
-- Se guarda el CÓDIGO OFICIAL de SUNAT ('03'), no una etiqueta legible
-- ('EMPLEADO'): el archivo plano del PLAME y del T-Registro exige el código
-- exacto, y guardar la etiqueta obliga a un mapeo manual en cada exportación.
--
-- Tablas cargadas (${filas.length} filas en total):
${detalle}
--
-- ------------------------------------------------------------------------------
-- OJO CON LA T28 — dos trampas, ambas silenciosas
-- ------------------------------------------------------------------------------
-- 1) NO es una tabla: son TRES listas independientes en columnas paralelas
--    (departamento / provincia / distrito). Las filas NO se corresponden entre
--    sí — en la fila 7 el departamento es ÁNCASH pero la provincia es BAGUA,
--    que pertenece a Amazonas. Leerla como una sola tabla cruza los datos.
--    Se cargan las tres bajo tabla_num=28 y la longitud del código dice el
--    nivel: 2=departamento, 4=provincia, 6=distrito.
--
-- 2) Es UBIGEO RENIEC, NO ubigeo INEI. El título de la hoja lo dice:
--    "TABLA 28 - UBIGEO RENIEC - PARA SER UTILIZADO EN EL T-REGISTRO".
--    No son el mismo código:
--        RENIEC:  Lima=14  Callao=24  Cusco=07  Loreto=15
--        INEI:    Lima=15  Callao=07  Cusco=08  Loreto=16
--    Casi todos los datasets de ubigeo que circulan en Perú son INEI. Si
--    alguien "corrige" estos códigos contra una tabla INEI, TODAS las
--    direcciones del T-Registro salen mal y SUNAT no necesariamente lo
--    rechaza: quedan trabajadores registrados en el distrito equivocado.
--    Estos códigos vienen del archivo oficial y NO deben tocarse.
--
-- Omitidas a propósito (el estudio lleva empresas del sector privado):
--   T10 Ocupación sector público · T31 Pliego presupuestal
--   T34 Instituciones educativas · T37 Organizaciones sindicales S.Público
--   TM B (no es catálogo: es la matriz de campos obligatorios por tipo)
--   T22 (vive en planilla_concepto, tiene su propia semilla)
--
-- vigente=0 -> SUNAT lo deshabilitó sin borrarlo (ej. tipo de documento 11,
-- Partida de nacimiento, deshabilitado el 19.05.2013). Se conserva porque los
-- registros históricos pueden seguir referenciándolo.
--
-- Idempotente: re-correr bd.sql no duplica.
-- ==============================================================================
INSERT INTO planilla_sunat_catalogo
 (tabla_num, tabla_nombre, codigo, descripcion, descripcion_abreviada,
  aplica_sector_privado, aplica_sector_publico, vigente, id_usuario_crea)
VALUES
${filas.join(',\n')}
ON DUPLICATE KEY UPDATE
  tabla_nombre          = VALUES(tabla_nombre),
  descripcion           = VALUES(descripcion),
  descripcion_abreviada = VALUES(descripcion_abreviada),
  aplica_sector_privado = VALUES(aplica_sector_privado),
  aplica_sector_publico = VALUES(aplica_sector_publico),
  vigente               = VALUES(vigente);
`;

  const r = reemplazarBloque(BLOQUE, sql);

  console.log(`OK  ${filas.length} filas en ${resumen.length} tablas`);
  resumen.forEach((r) => console.log(`    T${String(r.num).padStart(2)}  ${String(r.filas).padStart(5)}  ${r.nombre}`));
  console.log(`\n    bd.sql — bloque '${BLOQUE}': ${r.lineasAntes} -> ${r.lineasDespues} líneas`);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

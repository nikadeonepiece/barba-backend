/**
 * Genera la semilla SQL de `planilla_concepto` (Tabla 22 del PDT PLAME) a partir
 * del archivo oficial de tablas paramétricas de SUNAT.
 *
 * Por qué existe este script y no un INSERT escrito a mano en bd.sql:
 * son 311 conceptos con 15 columnas de afectación cada uno (EsSalud, SCTR,
 * SENATI, ONP, AFP, renta de 5ta...). Transcribir eso a mano garantiza errores,
 * y un código PLAME equivocado hace que SUNAT rechace la declaración. Además
 * SUNAT republica el archivo 1-4 veces al año: hay que poder regenerar, no
 * re-transcribir.
 *
 * Uso:
 *   node scripts/generar-seed-conceptos-plame.js
 *
 * Entrada:  bd/sunat-tablas-parametricas/tablas_2026.xlsx
 * Salida:   erp-backend/bd.sql — reemplaza el bloque marcado 'planilla_concepto'
 *           bd/sunat-tablas-parametricas/t22_2026.csv (solo para revisión manual)
 *
 * Cuando SUNAT publique una versión nueva: bajar el .xlsx desde
 * https://orientacion.sunat.gob.pe/7086-12-tablas-parametricas, reemplazar el
 * archivo de entrada y volver a correr esto.
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const DIR_TABLAS = path.resolve(__dirname, '..', '..', 'bd', 'sunat-tablas-parametricas');
const ARCHIVO_ENTRADA = path.join(DIR_TABLAS, 'tablas_2026.xlsx');
const { reemplazarBloque } = require('./lib/splice-bd-sql');

const BLOQUE = 'planilla_concepto';
const SALIDA_CSV = path.join(DIR_TABLAS, 't22_2026.csv');

// El nombre de la hoja trae un espacio al final en el archivo oficial. No es un typo.
const NOMBRE_HOJA = 'T22 Ing, Trib y Desc ';

// Columnas 3..17 de la hoja (1-indexed en ExcelJS) = matriz de afectación.
const AFECTACIONES = [
  'essalud_regular', 'essalud_cbssp', 'essalud_agrario', 'essalud_sctr', 'ies',
  'fdsa', 'senati', 'fcjtp', 'snp_19990', 'spp_afp', 'fcjmms', 'rep_pesquero',
  'renta_5ta', 'essalud_pensionista', 'contrib_solidaria',
];

// El código 0406 viene con la celda de descripción VACÍA en el .xlsx oficial
// (celda combinada). Se completa desde el PDF "Tabla N22 Definición Conceptos
// Plame" (01/10/2025). Es el único caso de los 311.
const NOMBRES_FALTANTES = {
  '0406': 'GRATIFICACIONES DE FIESTAS PATRIAS Y NAVIDAD - LEY 29351',
};

const texto = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.richText) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && v.text) return String(v.text);
  return String(v);
};

const limpiar = (v) => texto(v).replace(/\s+/g, ' ').trim();

const tipoDeGrupo = (grupo) => {
  if (/APORTACIONES DE CARGO DEL EMPLEADOR/i.test(grupo)) return 'APORTE_EMPLEADOR';
  if (/DESCUENTOS AL TRABAJADOR/i.test(grupo)) return 'DESCUENTO';
  if (/APORTACIONES DEL TRABAJADOR/i.test(grupo)) return 'DESCUENTO';
  return 'INGRESO';
};

// Régimen laboral público (D.Leg. 276) y BET fijo: no aplican a los clientes del
// estudio, pero se cargan igual por si alguna vez toman un cliente del Estado.
const esSoloSectorPublico = (grupo) =>
  /RÉGIMEN LABORAL PÚBLICO|BET FIJO NO IMPONIBLE/i.test(grupo) ? 1 : 0;

const escapar = (s) => s.replace(/'/g, "''");

async function main() {
  if (!fs.existsSync(ARCHIVO_ENTRADA)) {
    throw new Error(`No existe el archivo de entrada: ${ARCHIVO_ENTRADA}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(ARCHIVO_ENTRADA);

  const hoja = workbook.getWorksheet(NOMBRE_HOJA);
  if (!hoja) {
    const disponibles = workbook.worksheets.map((w) => JSON.stringify(w.name)).join(', ');
    throw new Error(`No se encontró la hoja ${JSON.stringify(NOMBRE_HOJA)}. Hojas: ${disponibles}`);
  }

  const conceptos = [];
  const omitidos = [];
  let grupo = '';

  hoja.eachRow((fila) => {
    const codigo = limpiar(fila.getCell(1).value);
    if (!/^\d{3,4}$/.test(codigo)) return;

    const codigo4 = codigo.padStart(4, '0');

    // Las filas cuyo código termina en 00 (100, 200, 900...) son encabezados de
    // grupo, no conceptos declarables.
    if (codigo4.endsWith('00')) {
      grupo = limpiar(fila.getCell(2).value);
      return;
    }

    const nombre = limpiar(fila.getCell(2).value) || NOMBRES_FALTANTES[codigo4] || '';
    if (!nombre) {
      omitidos.push(codigo4);
      return;
    }

    const afectaciones = {};
    AFECTACIONES.forEach((clave, i) => {
      afectaciones[clave] = limpiar(fila.getCell(3 + i).value).toUpperCase() === 'SI' ? 1 : 0;
    });

    conceptos.push({ codigo4, nombre, grupo, afectaciones });
  });

  if (!conceptos.length) throw new Error('No se extrajo ningún concepto: revisar el formato de la hoja.');
  if (omitidos.length) console.warn(`AVISO  ${omitidos.length} códigos sin nombre, omitidos: ${omitidos.join(', ')}`);

  const valores = conceptos.map((c, i) => {
    const a = c.afectaciones;
    // Un concepto es remunerativo si aporta a EsSalud o a algún sistema de pensiones.
    const esRemunerativo = a.essalud_regular || a.snp_19990 || a.spp_afp ? 1 : 0;
    return (
      `('${c.codigo4}','${escapar(c.nombre)}','${escapar(c.grupo)}','${tipoDeGrupo(c.grupo)}',` +
      `${esSoloSectorPublico(c.grupo)},${esRemunerativo},${a.renta_5ta},${a.essalud_regular},` +
      `${a.essalud_sctr},${a.senati},${a.snp_19990},${a.spp_afp},${a.ies},${(i + 1) * 10},0,1)`
    );
  });

  const privados = conceptos.filter((c) => !esSoloSectorPublico(c.grupo)).length;
  const publicos = conceptos.length - privados;

  const sql = `-- ==============================================================================
-- Semilla planilla_concepto — SUNAT Tabla 22 "Ingresos, Tributos y Descuentos"
--
-- GENERADO — no editar a mano. Re-correr:
--   node scripts/generar-seed-conceptos-plame.js
--
-- Fuente oficial: bd/sunat-tablas-parametricas/tablas_2026.xlsx
--                 (tablas_parametricas_actualizada-25.08.26.xlsx de SUNAT)
--                 https://orientacion.sunat.gob.pe/7086-12-tablas-parametricas
--
-- Total: ${conceptos.length} conceptos — ${privados} del sector privado, ${publicos} del público.
-- Los del sector público van con solo_sector_publico=1: la UI los oculta por
-- defecto, pero quedan declarados por si el estudio toma un cliente del Estado.
--
-- El nombre del código 0406 viene con la celda combinada VACÍA en el xlsx oficial;
-- se completó desde el PDF "Tabla N22 Definición Conceptos Plame" (01/10/2025).
--
-- editable=0 -> vino de SUNAT: la reimportación lo pisa.
-- editable=1 -> concepto propio del estudio: la reimportación NO lo toca.
--
-- Idempotente. El ON DUPLICATE KEY a propósito NO pisa base_cts / base_gratificacion
-- / base_vacaciones: esas son reglas del MTPE que define el estudio, no SUNAT, y
-- una reimportación no debe borrar ese trabajo.
-- ==============================================================================
INSERT INTO planilla_concepto
 (codigo_plame, nombre, grupo_sunat, tipo, solo_sector_publico,
  es_remunerativo, afecto_renta_quinta, afecto_essalud, afecto_sctr, afecto_senati,
  afecto_onp, afecto_afp, afecto_ies, orden_impresion, editable, id_usuario_crea)
VALUES
${valores.join(',\n')}
ON DUPLICATE KEY UPDATE
  nombre              = VALUES(nombre),
  grupo_sunat         = VALUES(grupo_sunat),
  tipo                = VALUES(tipo),
  solo_sector_publico = VALUES(solo_sector_publico),
  es_remunerativo     = VALUES(es_remunerativo),
  afecto_renta_quinta = VALUES(afecto_renta_quinta),
  afecto_essalud      = VALUES(afecto_essalud),
  afecto_sctr         = VALUES(afecto_sctr),
  afecto_senati       = VALUES(afecto_senati),
  afecto_onp          = VALUES(afecto_onp),
  afecto_afp          = VALUES(afecto_afp),
  afecto_ies          = VALUES(afecto_ies);
`;

  const r = reemplazarBloque(BLOQUE, sql);

  const csv =
    `codigo,grupo,nombre,tipo,solo_sector_publico,${AFECTACIONES.join(',')}\n` +
    conceptos
      .map((c) =>
        [
          c.codigo4,
          JSON.stringify(c.grupo),
          JSON.stringify(c.nombre),
          tipoDeGrupo(c.grupo),
          esSoloSectorPublico(c.grupo),
          ...AFECTACIONES.map((k) => c.afectaciones[k]),
        ].join(','),
      )
      .join('\n');
  fs.writeFileSync(SALIDA_CSV, csv, 'utf8');

  console.log(`OK  ${conceptos.length} conceptos (${privados} privado / ${publicos} público)`);
  console.log(`    bd.sql — bloque '${BLOQUE}': ${r.lineasAntes} -> ${r.lineasDespues} líneas`);
  console.log(`    ${SALIDA_CSV}`);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

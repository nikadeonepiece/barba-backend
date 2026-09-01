/**
 * Reemplaza un bloque generado dentro de erp-backend/bd.sql, entre sus marcadores.
 *
 * Por qué existe:
 * bd.sql es la ÚNICA fuente del esquema. Antes, los generadores de semillas
 * escribían archivos .sql aparte que después alguien copiaba a bd.sql a mano — dos
 * copias del mismo INSERT que se desincronizan en cuanto una se edita y la otra no,
 * y sin forma de saber cuál es la buena. Ahora el generador escribe directo acá y
 * hay una sola copia.
 *
 * Los marcadores se ven así dentro de bd.sql:
 *   -- >>> INICIO BLOQUE GENERADO: <nombre> — no editar a mano
 *   ...contenido generado...
 *   -- <<< FIN BLOQUE GENERADO: <nombre>
 */

const fs = require('fs');
const path = require('path');

const BD_SQL = path.resolve(__dirname, '..', '..', 'bd.sql');

const marcadorInicio = (nombre) => `-- >>> INICIO BLOQUE GENERADO: ${nombre} — no editar a mano`;
const marcadorFin = (nombre) => `-- <<< FIN BLOQUE GENERADO: ${nombre}`;

/**
 * @param {string} nombre    Nombre del bloque, tal cual aparece en los marcadores.
 * @param {string} contenido SQL nuevo que reemplaza al bloque.
 * @returns {{lineasAntes: number, lineasDespues: number}}
 */
function reemplazarBloque(nombre, contenido) {
  const original = fs.readFileSync(BD_SQL, 'utf8');

  const ini = marcadorInicio(nombre);
  const fin = marcadorFin(nombre);

  const i = original.indexOf(ini);
  if (i < 0) {
    throw new Error(
      `No encontré el marcador de inicio del bloque "${nombre}" en bd.sql.\n` +
        `Debe existir una línea exactamente igual a:\n  ${ini}`,
    );
  }

  const j = original.indexOf(fin, i);
  if (j < 0) {
    throw new Error(`Encontré el inicio del bloque "${nombre}" pero no su marcador de cierre:\n  ${fin}`);
  }

  // Verificación de seguridad: bd.sql pesa cientos de KB y un bug acá lo dejaría
  // truncado. Si el reemplazo dejara el archivo mucho más chico, es un error, no un
  // resultado válido.
  const bloqueViejo = original.slice(i, j + fin.length);
  const nuevo = original.slice(0, i) + ini + '\n' + contenido.trim() + '\n' + fin + original.slice(j + fin.length);

  if (nuevo.length < original.length - bloqueViejo.length) {
    throw new Error(`El reemplazo del bloque "${nombre}" habría truncado bd.sql. Abortado sin escribir.`);
  }

  fs.writeFileSync(BD_SQL, nuevo, 'utf8');

  return {
    lineasAntes: bloqueViejo.split('\n').length,
    lineasDespues: contenido.trim().split('\n').length + 2,
  };
}

module.exports = { reemplazarBloque, BD_SQL };

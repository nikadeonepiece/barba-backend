/**
 * Sesión SUPERVISADA para confirmar los selectores del T-Registro.
 *
 * Por qué un script y no un botón en la app:
 * lo que hace falta acá no es "traer los trabajadores", es MIRAR qué hay en pantalla
 * y anotar los textos exactos del menú. El script imprime el diagnóstico completo en
 * consola —incluido el volcado de opciones visibles cuando un menú no aparece—, que
 * es justo el dato para corregir el selector. En la app eso sería un modal inútil.
 *
 * Por qué llama al ENDPOINT y no instancia las clases directamente:
 * el build de NestJS es un bundle de webpack (`dist/apps/api/main.js`) que no exporta
 * las clases sueltas. Llamando al endpoint se ejecuta exactamente el mismo código que
 * corre en producción — si se probara contra otra ruta, se estaría verificando algo
 * distinto de lo que después se usa.
 *
 * Uso:
 *   node scripts/verificar-tregistro.js <ID_EMPRESA>
 *   node scripts/verificar-tregistro.js --listar          (ver empresas con Clave SOL)
 *
 * Requiere que el backend esté corriendo.
 *
 * ⚠️ ANTES DE CORRER ESTO:
 *
 * 1. Usa la Clave SOL REAL de un cliente del estudio. No es una prueba inocua.
 *
 * 2. El WAF de SUNAT corta conexiones tras ~8 sesiones seguidas en poco tiempo
 *    (documentado en vencimientos/sincronizacion-sunat/sunat-scraping.client.ts).
 *    Espaciar los intentos. Insistir arriesga que le restrinjan el acceso a la
 *    cuenta del cliente — peor que cargar el padrón a mano.
 *
 * 3. Elegir una empresa con POCOS trabajadores para la primera prueba.
 *
 * 4. Al confirmar los pasos reales, actualizar LOS DOS lugares:
 *      - el bloque SELECTORES de
 *        apps/api/src/erp/estudio-barba/planilla/trabajadores/sunat-tregistro-scraping.client.ts
 *      - la guía 'TREG' en guias_sunat (Configuración → Guías SUNAT)
 *    Si solo actualizas uno, quedan describiendo recorridos distintos.
 */

require('dotenv').config();

const API = process.env.API_URL_LOCAL || `http://localhost:${process.env.PORT || 3777}/api`;
const CORREO = process.env.SCRIPT_ADMIN_CORREO || 'admin@gmail.com';
const CLAVE = process.env.SCRIPT_ADMIN_CLAVE || '123456';

async function login() {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ correo: CORREO, password: CLAVE }),
  });
  if (!r.ok) {
    throw new Error(
      `No se pudo iniciar sesión en la API (${r.status}). ¿El backend está corriendo en ${API}? ` +
      'Si el usuario admin cambió, define SCRIPT_ADMIN_CORREO y SCRIPT_ADMIN_CLAVE en el .env.',
    );
  }
  const j = await r.json();
  const token = j?.data?.access_token ?? j?.access_token;
  if (!token) throw new Error('La API respondió sin token de acceso');
  return token;
}

async function listarEmpresas(token) {
  const r = await fetch(`${API}/planilla/trabajadores/empresas`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  const empresas = j?.data ?? [];

  console.log('\nEmpresas disponibles (elige una con POCOS trabajadores para la primera prueba):\n');
  empresas.slice(0, 40).forEach((e) => {
    console.log(`  ${String(e.id_empresa).padStart(4)}  ${String(e.ruc).padEnd(12)} ${String(e.razon_social).slice(0, 46).padEnd(48)} ${e.trabajadores_activos} trab.`);
  });
  if (empresas.length > 40) console.log(`  ... y ${empresas.length - 40} más`);
  console.log('\n  node scripts/verificar-tregistro.js <ID_EMPRESA>\n');
}

async function verificar(token, idEmpresa) {
  console.log(`\nConsultando el T-Registro de la empresa ${idEmpresa}...`);
  console.log('Se abrirá una ventana de Chrome. NO la cierres: mira qué pasa en cada paso.\n');

  const r = await fetch(
    `${API}/planilla/trabajadores/empresas/${idEmpresa}/consultar-tregistro?supervisado=true`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );

  const j = await r.json();
  if (!r.ok) {
    console.error(`\nLa API respondió ${r.status}: ${j?.mensaje ?? j?.message ?? JSON.stringify(j).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }

  const d = j?.data ?? j;

  console.log(`\nEmpresa: ${d.empresa} (RUC ${d.ruc})`);

  console.log('\n─────────── DIAGNÓSTICO ───────────');
  (d.diagnostico ?? []).forEach((linea) => console.log('  ' + linea));

  console.log('\n─────────── RESULTADO ───────────');
  console.log('  ' + d.mensaje);

  if (d.trabajadores?.length) {
    console.log(`\n  ${d.trabajadores.length} leídos · ${d.nuevos} nuevos (el resto ya está en el sistema)`);
    console.log('\n  Primeras filas — REVISA QUE LAS COLUMNAS ESTÉN BIEN INTERPRETADAS:\n');
    d.trabajadores.slice(0, 5).forEach((t) => {
      console.log(`    doc: ${t.numero_documento} | nombre: ${t.nombre_completo}`);
      console.log(`    ingreso: ${t.fecha_ingreso} | pensión: ${t.regimen_pensionario} | sueldo: ${t.sueldo_basico}`);
      console.log(`    fila cruda: ${JSON.stringify(t.crudo)}\n`);
    });
  }

  console.log('Si algo no coincide, corrige el bloque SELECTORES del cliente Y la guía TREG.\n');
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Falta el ID de la empresa.\n  node scripts/verificar-tregistro.js <ID_EMPRESA>\n  node scripts/verificar-tregistro.js --listar');
    process.exitCode = 1;
    return;
  }

  const token = await login();

  if (arg === '--listar') return listarEmpresas(token);

  const idEmpresa = Number(arg);
  if (!idEmpresa || Number.isNaN(idEmpresa)) {
    console.error(`"${arg}" no es un ID de empresa válido`);
    process.exitCode = 1;
    return;
  }
  return verificar(token, idEmpresa);
}

// `process.exitCode` y no `process.exit()`: cortar el proceso con sockets de fetch
// todavía abiertos hace que libuv imprima un "Assertion failed" en Windows que parece
// un crash y no lo es.
main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exitCode = 1;
});

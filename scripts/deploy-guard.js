/**
 * Seguro anti-despliegue-cruzado.
 *
 * Los scripts `deploy` de package.json llevan el servidor escrito fijo
 * (barba / barba.difusioneslaborales.com). Ese servidor es una cuenta de cPanel
 * COMPARTIDA con otros 5 proyectos (montero, tirno, yunta, dentaonepiece,
 * asistencia): un `npm run deploy` distraido desde un proyecto copiado subiria
 * el backend equivocado ENCIMA de la API del ERP de Barba en produccion.
 * Este guard corta eso antes de que pase.
 *
 * Compara el `name` del package.json con el proyecto esperado. Si no coincide,
 * aborta y explica que hay que hacer.
 */
const path = require('path');

const PROYECTO_ESPERADO = 'erp-backend';
const DESTINO = 'difusion@barba.difusioneslaborales.com:~/barba.difusioneslaborales.com/api/main.js';

const pkg = require(path.join(__dirname, '..', 'package.json'));

if (pkg.name !== PROYECTO_ESPERADO) {
  console.error('');
  console.error('  DESPLIEGUE ABORTADO');
  console.error('  ------------------------------------------------------------');
  console.error(`  Este package.json dice llamarse "${pkg.name}", pero los scripts`);
  console.error(`  de deploy son de "${PROYECTO_ESPERADO}" y apuntan a:`);
  console.error('');
  console.error('      ' + DESTINO);
  console.error('');
  console.error('  Si copiaste este proyecto como base para otro cliente, NO lo');
  console.error('  despliegues asi: sobreescribirias la API del ERP de Barba en');
  console.error('  produccion con un backend distinto.');
  console.error('');
  console.error('  Que hacer: en package.json, cambia los scripts deploy/restart/');
  console.error('  logs para que apunten al servidor del proyecto nuevo, y ajusta');
  console.error('  PROYECTO_ESPERADO y DESTINO en scripts/deploy-guard.js.');
  console.error('');
  process.exit(1);
}

// Mensaje neutro a proposito: este guard corre en deploy, deploy:ok,
// deploy:rollback y restart. Decir "Desplegando" seria mentira en tres de los
// cuatro (deploy:ok solo borra el respaldo, restart no sube nada).
console.log('');
console.log('  Proyecto: ' + pkg.name);
console.log('  Servidor: ' + DESTINO);
console.log('');

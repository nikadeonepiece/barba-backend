/**
 * Aplica el módulo PLANILLAS CLIENTE sobre una base YA CARGADA.
 *
 * Existe porque `bd.sql` no se puede correr entero contra una base con datos: arranca
 * con `DROP DATABASE`. Este script hace lo que dice CLAUDE.md ("copiar de bd.sql el
 * bloque de ese módulo y correr solo eso"), pero leyendo los fragmentos DEL PROPIO
 * bd.sql en vez de tener una copia acá — una copia se desincroniza en el primer cambio
 * y nadie se entera hasta que la base de producción queda distinta de la de desarrollo.
 *
 * Es idempotente: correrlo dos veces no duplica nada ni falla.
 *
 * Uso:  node scripts/aplicar-planillas-cliente.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const BD_SQL = path.resolve(__dirname, '..', 'bd.sql');
const sql = fs.readFileSync(BD_SQL, 'utf8');

/**
 * Recorta un `CREATE PROCEDURE` de bd.sql. Con indexOf y no con una expresión regular:
 * el archivo está lleno de backticks y de comentarios `/*!50003 ... *\/` de mysqldump,
 * y una regex sobre eso es más fácil de romper que de leer.
 *
 * El `;;` del final es el delimitador de mysqldump; mysql2 ejecuta una sentencia por
 * llamada, así que sobra y se quita.
 */
function procedimiento(nombre) {
  const marca = 'CREATE PROCEDURE `' + nombre + '`';
  const desde = sql.indexOf(marca);
  if (desde === -1) throw new Error('No se encontró el procedimiento ' + nombre + ' en bd.sql');

  const fin = sql.indexOf('\nEND ;;', desde);
  if (fin === -1) throw new Error('No se encontró el cierre de ' + nombre + ' en bd.sql');

  return sql.slice(desde, fin) + '\nEND';
}

/** Recorta el bloque completo de la sección 8 (tabla + módulo + acciones + rol). */
function bloqueSeccion8() {
  const desde = sql.indexOf('-- 8. MÓDULO PLANILLAS CLIENTE');
  const hasta = sql.indexOf('-- MIGRACIONES SOBRE BASES YA EXISTENTES');
  if (desde === -1 || hasta === -1 || hasta < desde) {
    throw new Error('No se encontró la sección 8 en bd.sql');
  }
  return sql.slice(desde, hasta);
}

// Los cinco SP de sis_usuario cambiaron de firma: `crear` y `actualizar` reciben
// `p_id_empresa`, y los otros tres devuelven la empresa en el SELECT.
const SPS = [
  'sis_usuario_crear',
  'sis_usuario_actualizar',
  'sis_usuario_listar',
  'sis_usuario_obtener',
  'sis_usuario_obtener_por_correo',
];

(async () => {
  const conexion = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    multipleStatements: true,
  });

  try {
    const [[antes]] = await conexion.query(
      'SELECT (SELECT COUNT(*) FROM empresa) empresas, (SELECT COUNT(*) FROM sis_usuario) usuarios',
    );
    console.log(`Base: ${process.env.DB_DATABASE} — ${antes.empresas} empresas, ${antes.usuarios} usuarios`);

    // ---- 1. Columna de scope --------------------------------------------------
    const [col] = await conexion.query("SHOW COLUMNS FROM sis_usuario LIKE 'id_empresa'");
    if (col.length === 0) {
      await conexion.query(
        "ALTER TABLE `sis_usuario` ADD COLUMN `id_empresa` int DEFAULT NULL " +
        "COMMENT 'Empresa cliente a la que pertenece el usuario. NULL = usuario del estudio' AFTER `id_rol`",
      );
      await conexion.query('ALTER TABLE `sis_usuario` ADD KEY `fk_sis_usuario_empresa` (`id_empresa`)');
      await conexion.query(
        'ALTER TABLE `sis_usuario` ADD CONSTRAINT `fk_sis_usuario_empresa` ' +
        'FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE RESTRICT',
      );
      console.log('OK  sis_usuario.id_empresa (columna + índice + FK)');
    } else {
      console.log('--  sis_usuario.id_empresa ya existía');
    }

    // ---- 2. Stored procedures -------------------------------------------------
    for (const nombre of SPS) {
      await conexion.query('DROP PROCEDURE IF EXISTS `' + nombre + '`');
      await conexion.query(procedimiento(nombre));
      console.log('OK  SP ' + nombre);
    }

    // ---- 3. Tabla, módulo, acciones y rol ------------------------------------
    await conexion.query(bloqueSeccion8());
    console.log('OK  bloque sección 8 (planilla_contrato + PLANILLAS_CLIENTE + rol CLIENTE)');

    // ---- Verificación ---------------------------------------------------------
    const [tabla] = await conexion.query("SHOW TABLES LIKE 'planilla_contrato'");
    const [modulo] = await conexion.query("SELECT nombre, etiqueta FROM sis_modulo WHERE nombre = 'PLANILLAS_CLIENTE'");
    const [rol] = await conexion.query("SELECT id_rol FROM sis_rol WHERE nombre = 'CLIENTE'");
    const [permisos] = await conexion.query(
      `SELECT a.codigo_accion FROM sis_permiso p
       JOIN sis_accion a ON a.id_accion = p.id_accion
       JOIN sis_rol r ON r.id_rol = p.id_rol
       WHERE r.nombre = 'CLIENTE' AND p.estado_registro = 'ACTIVO'
       ORDER BY a.codigo_accion`,
    );
    const [[despues]] = await conexion.query(
      'SELECT (SELECT COUNT(*) FROM empresa) empresas, (SELECT COUNT(*) FROM sis_usuario) usuarios',
    );

    console.log('\n--- VERIFICACIÓN ---');
    console.log('planilla_contrato :', tabla.length ? 'existe' : 'NO EXISTE');
    console.log('módulo            :', modulo[0] ? `${modulo[0].nombre} (${modulo[0].etiqueta})` : 'NO EXISTE');
    console.log('rol CLIENTE       :', rol[0] ? 'id ' + rol[0].id_rol : 'NO EXISTE');
    console.log('permisos del rol  :', permisos.map((p) => p.codigo_accion).join(', ') || '(ninguno)');
    console.log(`datos             : ${despues.empresas} empresas, ${despues.usuarios} usuarios`);
  } finally {
    await conexion.end();
  }
})().catch((e) => {
  console.error('FALLÓ:', e.sqlMessage || e.message);
  process.exit(1);
});

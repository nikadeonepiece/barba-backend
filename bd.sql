-- ==============================================================================
-- ESTUDIOBARBA — Núcleo del sistema (Seguridad y Auditoría)
-- Base para un proyecto nuevo. Contiene solo la estructura core (tablas +
-- stored procedures de sis_modulo/sis_rol/sis_usuario/sis_accion/sis_permiso/
-- sis_auditoria) y el usuario administrador inicial. Los módulos propios de
-- este proyecto (contabilidad) se agregan aparte.
-- ==============================================================================
-- El COLLATE explícito es obligatorio: si el servidor MySQL tiene un collation_server
-- distinto (ej. utf8mb4_0900_ai_ci, el default en MySQL 8.x), los parámetros VARCHAR de
-- los stored procedures heredan el collation de la base, no el de las tablas (que sí
-- declaran utf8mb4_unicode_ci) — cualquier comparación tipo `WHERE columna = parametro`
-- revienta con "Illegal mix of collations". Detectado en vivo al probar el login real.
-- ------------------------------------------------------------------------------
-- FUENTE ÚNICA DEL ESQUEMA: todo el schema vive en ESTE archivo. Ya no hay
-- migraciones sueltas en bd/ (las de casilla SUNAFIL, estado_pago y buzón SUNAT se
-- consolidaron acá y se borraron): estaban duplicadas y la de estado_pago había
-- quedado DESACTUALIZADA respecto de los stored procedures de este archivo — correrla
-- habría revertido el manejo de AFP_NET en declaracion_listar_periodo y la preservación de
-- estado_pago = PAGADO en declaracion_marcar_error.
--
-- Para aplicar un módulo sobre una base YA cargada, copiar de acá el bloque de ese
-- módulo y correr solo eso. NUNCA correr bd.sql completo en producción: hace DROP
-- TABLE y perdería los datos ya cargados.
-- ------------------------------------------------------------------------------
-- Este script NO crea la base de datos (hosting compartido no da permiso CREATE/DROP DATABASE
-- al usuario de la cuenta) — se ejecuta contra una base ya creada y seleccionada:
--   Local:   mysql -u root -p ESTUDIOBARBA < bd.sql   (crear antes con CREATE DATABASE IF NOT EXISTS ESTUDIOBARBA DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;)
--   Hosting: crear la base desde el panel (cPanel/Plesk) con el nombre real que asigne (ej. difusion_estudiobarba)
--            y luego: mysql -u difusion -p difusion_estudiobarba < bd.sql

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

-- ==============================================================================
-- ESTRUCTURA (tablas + stored procedures)
-- ==============================================================================
/*!50503 SET NAMES utf8mb4 */;
-- ==============================================================================
-- 0. CORE DEL SISTEMA (SEGURIDAD Y AUDITORÍA) - INTOCABLE
--    Reutilizable tal cual en cualquier proyecto nuevo.
-- ==============================================================================
DROP TABLE IF EXISTS `sis_modulo`;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sis_modulo` (
  `id_modulo` int NOT NULL AUTO_INCREMENT COMMENT 'Llave primaria del módulo',
  `nombre` varchar(50) NOT NULL COMMENT 'Nombre interno del módulo usado por @RequirePermissions (ej: USUARIOS)',
  `etiqueta` varchar(100) NOT NULL COMMENT 'Nombre legible que se mostrará en el menú (ej: Usuarios)',
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO' COMMENT 'Soft delete del módulo',
  PRIMARY KEY (`id_modulo`),
  UNIQUE KEY `uk_nombre_modulo` (`nombre`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Seguridad. Catálogo de módulos principales del sistema.';
DROP TABLE IF EXISTS `sis_rol`;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sis_rol` (
  `id_rol` int NOT NULL AUTO_INCREMENT COMMENT 'Llave primaria del rol',
  `nombre` varchar(50) NOT NULL COMMENT 'Nombre interno del rol (Ej: SUPERADMIN, CONTADOR)',
  `descripcion` text COMMENT 'Detalle de las responsabilidades de este rol',
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO' COMMENT 'Soft delete',
  PRIMARY KEY (`id_rol`),
  UNIQUE KEY `uk_nombre_rol` (`nombre`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Seguridad. Roles de acceso para los usuarios.';
DROP TABLE IF EXISTS `sis_usuario`;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sis_usuario` (
  `id_usuario` int NOT NULL AUTO_INCREMENT COMMENT 'Llave primaria del usuario',
  `id_rol` int NOT NULL COMMENT 'Rol asignado al usuario',
  `nombres` varchar(100) NOT NULL COMMENT 'Nombres del usuario',
  `apellidos` varchar(100) NOT NULL COMMENT 'Apellidos del usuario',
  `correo` varchar(150) NOT NULL COMMENT 'Correo usado para el login',
  `password` varchar(255) NOT NULL COMMENT 'Contraseña encriptada (Hash)',
  `estado_registro` enum('ACTIVO','ELIMINADO','BLOQUEADO') NOT NULL DEFAULT 'ACTIVO' COMMENT 'Estado de acceso al sistema',
  `primera_sesion` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'Se pone en 0 tras el primer login (usuarios.service.ts leerYMarcarPrimeraSesion) — columna que faltaba, el código ya la asumía',
  `fecha_registro` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Cuándo se creó el usuario',
  PRIMARY KEY (`id_usuario`),
  UNIQUE KEY `correo` (`correo`),
  KEY `fk_sis_usuario_rol` (`id_rol`),
  CONSTRAINT `fk_sis_usuario_rol` FOREIGN KEY (`id_rol`) REFERENCES `sis_rol` (`id_rol`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Seguridad. Usuarios con acceso al sistema web.';
DROP TABLE IF EXISTS `sis_accion`;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sis_accion` (
  `id_accion` int NOT NULL AUTO_INCREMENT COMMENT 'Llave primaria de la acción',
  `id_modulo` int NOT NULL COMMENT 'Módulo al que pertenece la acción',
  `codigo_accion` varchar(50) NOT NULL COMMENT 'Código para los guards del backend (ej: crear_usuario)',
  `descripcion` varchar(200) NOT NULL COMMENT 'Explicación humana de qué hace el micropoder',
  `tipo_operacion` enum('CREATE','READ','UPDATE','DELETE','SPECIAL') NOT NULL DEFAULT 'READ' COMMENT 'Naturaleza del micropoder',
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO' COMMENT 'Soft delete',
  PRIMARY KEY (`id_accion`),
  UNIQUE KEY `uk_accion_modulo` (`id_modulo`,`codigo_accion`),
  CONSTRAINT `fk_sis_accion_modulo` FOREIGN KEY (`id_modulo`) REFERENCES `sis_modulo` (`id_modulo`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Seguridad. Acciones o micropoderes específicos por módulo.';
DROP TABLE IF EXISTS `sis_permiso`;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sis_permiso` (
  `id_permiso` int NOT NULL AUTO_INCREMENT COMMENT 'Llave primaria del permiso',
  `id_rol` int NOT NULL COMMENT 'Rol al que se le da el permiso',
  `id_accion` int NOT NULL COMMENT 'Acción que el rol puede ejecutar',
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO' COMMENT 'Soft delete',
  PRIMARY KEY (`id_permiso`),
  UNIQUE KEY `uk_rol_accion` (`id_rol`,`id_accion`),
  KEY `fk_permiso_accion` (`id_accion`),
  CONSTRAINT `fk_permiso_accion` FOREIGN KEY (`id_accion`) REFERENCES `sis_accion` (`id_accion`) ON DELETE CASCADE,
  CONSTRAINT `fk_permiso_rol` FOREIGN KEY (`id_rol`) REFERENCES `sis_rol` (`id_rol`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Seguridad. Tabla pivote que une Roles con Acciones.';
DROP TABLE IF EXISTS `sis_auditoria`;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sis_auditoria` (
  `id_auditoria` int NOT NULL AUTO_INCREMENT COMMENT 'Llave primaria del registro forense',
  `nombre_tabla` varchar(50) NOT NULL COMMENT 'En qué tabla ocurrió el cambio',
  `id_registro` int NOT NULL COMMENT 'ID de la fila afectada',
  `accion` enum('CREAR','ACTUALIZAR','ELIMINAR','ANULAR') NOT NULL COMMENT 'Qué le hicieron al registro',
  `id_usuario` int NOT NULL COMMENT 'Quién ejecutó la acción',
  `valores_antiguos` json DEFAULT NULL COMMENT 'JSON con los datos antes del cambio',
  `valores_nuevos` json DEFAULT NULL COMMENT 'JSON con los datos después del cambio',
  `fecha` datetime DEFAULT CURRENT_TIMESTAMP COMMENT 'Momento exacto del suceso',
  PRIMARY KEY (`id_auditoria`),
  KEY `fk_audit_usuario` (`id_usuario`),
  CONSTRAINT `fk_audit_usuario` FOREIGN KEY (`id_usuario`) REFERENCES `sis_usuario` (`id_usuario`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Auditoría. Tracker forense inmutable.';

DROP TABLE IF EXISTS `auth_refresh_tokens`;
CREATE TABLE `auth_refresh_tokens` (
  `id_refresh_token` int NOT NULL AUTO_INCREMENT,
  `id_usuario` int NOT NULL,
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 hex del token random de 64 bytes — el texto plano nunca se guarda, solo va en la cookie httpOnly',
  `fecha_expira` datetime NOT NULL,
  `revocado` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Se marca en 1 al rotar (usado en /auth/refresh) o al hacer logout',
  `fecha_revocado` datetime DEFAULT NULL COMMENT 'Cuándo se revocó — habilita la ventana de gracia para refrescos concurrentes',
  `reemplazado_por` int DEFAULT NULL COMMENT 'Token que sucedió a este al rotar. Permite seguir la cadena cuando dos pestañas refrescan a la vez, y detectar reuso de token robado',
  `ip_origen` varchar(45) DEFAULT NULL COMMENT 'IP desde la que se emitió (IPv6 entra en 45 chars)',
  `user_agent` varchar(255) DEFAULT NULL COMMENT 'Navegador/cliente que lo pidió — auditoría de sesión',
  `fecha_creacion` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_refresh_token`),
  UNIQUE KEY `uk_token_hash` (`token_hash`),
  KEY `fk_refresh_usuario` (`id_usuario`),
  KEY `idx_refresh_reemplazado` (`reemplazado_por`),
  CONSTRAINT `fk_refresh_usuario` FOREIGN KEY (`id_usuario`) REFERENCES `sis_usuario` (`id_usuario`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Seguridad. Refresh tokens para renovar el access token JWT sin volver a pedir contraseña.';

-- ==============================================================================
-- PROCEDIMIENTOS CORE (Seguridad y Auditoría) - INTOCABLE
-- ==============================================================================

/*!50003 DROP PROCEDURE IF EXISTS `sis_auditoria_registrar` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_auditoria_registrar`(
    IN p_tabla VARCHAR(100), IN p_id_registro INT, IN p_accion VARCHAR(20),
    IN p_id_usuario INT, IN p_valores_antiguos JSON, IN p_valores_nuevos JSON
)
BEGIN
    INSERT INTO sis_auditoria (nombre_tabla, id_registro, accion, id_usuario, valores_antiguos, valores_nuevos)
    VALUES (p_tabla, p_id_registro, p_accion, p_id_usuario, p_valores_antiguos, p_valores_nuevos);
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_matriz_modulos_listar` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_matriz_modulos_listar`()
BEGIN
    SELECT m.id_modulo, m.nombre AS etiqueta, a.id_accion, a.codigo_accion AS codigo, a.descripcion
    FROM sis_modulo m LEFT JOIN sis_accion a ON m.id_modulo = a.id_modulo
    WHERE m.estado_registro = 'ACTIVO' ORDER BY m.id_modulo ASC, a.id_accion ASC;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_permiso_asignar` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_permiso_asignar`(IN p_id_rol INT, IN p_id_accion INT)
BEGIN
    INSERT IGNORE INTO sis_permiso (id_rol, id_accion) VALUES (p_id_rol, p_id_accion);
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_permiso_ids_por_rol` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_permiso_ids_por_rol`(IN p_id_rol INT)
BEGIN
    SELECT id_accion FROM sis_permiso WHERE id_rol = p_id_rol;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_permiso_limpiar_rol` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_permiso_limpiar_rol`(IN p_id_rol INT)
BEGIN
    DELETE FROM sis_permiso WHERE id_rol = p_id_rol;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_permiso_obtener_por_rol` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_permiso_obtener_por_rol`(IN p_id_rol INT)
BEGIN
    SELECT a.codigo_accion AS codigo FROM sis_permiso p INNER JOIN sis_accion a ON p.id_accion = a.id_accion
    WHERE p.id_rol = p_id_rol;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_rol_actualizar` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_rol_actualizar`(IN p_id INT, IN p_nombre VARCHAR(50), IN p_descripcion TEXT)
BEGIN
    UPDATE sis_rol SET nombre = p_nombre, descripcion = p_descripcion WHERE id_rol = p_id;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_rol_crear` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_rol_crear`(IN p_nombre VARCHAR(50), IN p_descripcion TEXT)
BEGIN
    INSERT INTO sis_rol (nombre, descripcion, estado_registro) VALUES (p_nombre, p_descripcion, 'ACTIVO');
    SELECT LAST_INSERT_ID() AS id_insertado;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_rol_eliminar` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_rol_eliminar`(IN p_id INT)
BEGIN
    DECLARE v_total INT;
    SELECT COUNT(*) INTO v_total FROM sis_usuario WHERE id_rol = p_id AND estado_registro = 'ACTIVO';
    IF v_total > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No se puede eliminar el rol porque tiene usuarios activos asignados.';
    END IF;
    UPDATE sis_rol SET estado_registro = 'ELIMINADO' WHERE id_rol = p_id;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_rol_listar` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_rol_listar`()
BEGIN
    SELECT id_rol, nombre, descripcion FROM sis_rol WHERE estado_registro = 'ACTIVO' ORDER BY id_rol ASC;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_usuario_actualizar` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_usuario_actualizar`(
    IN p_id INT, IN p_id_rol INT, IN p_nombres VARCHAR(100),
    IN p_apellidos VARCHAR(100), IN p_correo VARCHAR(150)
)
BEGIN
    UPDATE sis_usuario SET id_rol = p_id_rol, nombres = p_nombres, apellidos = p_apellidos, correo = p_correo
    WHERE id_usuario = p_id;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_usuario_crear` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_usuario_crear`(
    IN p_id_rol INT, IN p_id_cliente INT, IN p_nombres VARCHAR(100),
    IN p_apellidos VARCHAR(100), IN p_correo VARCHAR(150), IN p_password VARCHAR(255)
)
BEGIN
    INSERT INTO sis_usuario (id_rol, nombres, apellidos, correo, password)
    VALUES (p_id_rol, p_nombres, p_apellidos, p_correo, p_password);
    SELECT LAST_INSERT_ID() AS id_insertado;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_usuario_eliminar` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_usuario_eliminar`(IN p_id INT)
BEGIN
    UPDATE sis_usuario SET estado_registro = 'ELIMINADO' WHERE id_usuario = p_id;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_usuario_listar` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_usuario_listar`(IN p_id_rol INT, IN p_estado VARCHAR(20))
BEGIN
    SELECT u.id_usuario, u.nombres, u.apellidos, u.correo, r.nombre AS rol, u.estado_registro
    FROM sis_usuario u
    INNER JOIN sis_rol r ON u.id_rol = r.id_rol
    WHERE (p_id_rol IS NULL OR u.id_rol = p_id_rol)
      AND (p_estado IS NULL OR u.estado_registro = p_estado)
    ORDER BY u.apellidos ASC;
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_usuario_obtener` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_usuario_obtener`(IN p_id INT)
BEGIN
    SELECT u.id_usuario, u.nombres, u.apellidos, u.correo, u.id_rol, r.nombre AS rol, u.estado_registro
    FROM sis_usuario u
    INNER JOIN sis_rol r ON u.id_rol = r.id_rol
    WHERE u.id_usuario = p_id AND u.estado_registro != 'ELIMINADO';
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 DROP PROCEDURE IF EXISTS `sis_usuario_obtener_por_correo` */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
CREATE PROCEDURE `sis_usuario_obtener_por_correo`(IN p_credencial VARCHAR(150))
BEGIN
    SELECT u.id_usuario, u.nombres, u.apellidos, u.correo, u.password,
           u.id_rol, r.nombre AS rol, u.estado_registro
    FROM sis_usuario u
    INNER JOIN sis_rol r ON u.id_rol = r.id_rol
    WHERE u.correo = p_credencial AND u.estado_registro = 'ACTIVO';
END ;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;

-- ==============================================================================
-- 1. MÓDULO VENCIMIENTOS — Fase 1 (manual) + Fase 2 (automatización SUNAT)
--    Control tributario/laboral de las empresas cliente del estudio.
-- ==============================================================================

-- ---------- FASE 1: tablas núcleo ----------

DROP TABLE IF EXISTS `empresa`;
CREATE TABLE `empresa` (
  `id_empresa` int NOT NULL AUTO_INCREMENT,
  `razon_social` varchar(200) NOT NULL,
  `ruc` char(11) NOT NULL COMMENT 'RUC de la empresa cliente',
  `regimen_tributario` enum('MYPE','RER','NRUS','R.GENERAL') NOT NULL,
  `estado_cliente` enum('ACTIVO','INACTIVO') NOT NULL DEFAULT 'ACTIVO' COMMENT 'Si el estudio sigue llevando esta empresa',
  `estado_sunat` enum('ACTIVO','SUSPENDIDA','BAJA_DEFINITIVA') NOT NULL DEFAULT 'ACTIVO' COMMENT 'Situación de la empresa ante SUNAT, informativo',
  `observaciones` text,
  `sunat_sol_usuario` varbinary(255) DEFAULT NULL COMMENT 'Cifrado en aplicación (AES-256-GCM), no MySQL AES_ENCRYPT',
  `sunat_sol_password` varbinary(255) DEFAULT NULL COMMENT 'Cifrado en aplicación. Clave SOL para acceso manual de una persona',
  `sunat_api_client_id` varbinary(255) DEFAULT NULL COMMENT 'Cifrado en aplicación. Credencial OAuth2 de api.sunat.gob.pe para uso del sistema (Fase 2)',
  `sunat_api_client_secret` varbinary(255) DEFAULT NULL COMMENT 'Cifrado en aplicación',
  `afp_net_codigo_envio` varchar(50) DEFAULT NULL,
  `afp_net_usuario` varbinary(255) DEFAULT NULL COMMENT 'Cifrado en aplicación. Reservado, sin uso real todavía',
  `afp_net_password` varbinary(255) DEFAULT NULL COMMENT 'Cifrado en aplicación',
  `id_encargado_contable` int DEFAULT NULL COMMENT 'Responsable de IGV/Renta',
  `id_encargado_laboral` int DEFAULT NULL COMMENT 'Responsable de Planilla/AFP',
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO',
  `fecha_registro` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `id_usuario_crea` int NOT NULL,
  `id_usuario_mod` int DEFAULT NULL,
  PRIMARY KEY (`id_empresa`),
  UNIQUE KEY `uk_empresa_ruc` (`ruc`),
  KEY `fk_empresa_encargado_contable` (`id_encargado_contable`),
  KEY `fk_empresa_encargado_laboral` (`id_encargado_laboral`),
  KEY `fk_empresa_usuario_crea` (`id_usuario_crea`),
  CONSTRAINT `fk_empresa_encargado_contable` FOREIGN KEY (`id_encargado_contable`) REFERENCES `sis_usuario` (`id_usuario`) ON DELETE SET NULL,
  CONSTRAINT `fk_empresa_encargado_laboral` FOREIGN KEY (`id_encargado_laboral`) REFERENCES `sis_usuario` (`id_usuario`) ON DELETE SET NULL,
  CONSTRAINT `fk_empresa_usuario_crea` FOREIGN KEY (`id_usuario_crea`) REFERENCES `sis_usuario` (`id_usuario`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos. Empresas cliente del estudio (nivel RUC).';

DROP TABLE IF EXISTS `cronograma_vencimiento`;
CREATE TABLE `cronograma_vencimiento` (
  `id_cronograma` int NOT NULL AUTO_INCREMENT,
  `anio` smallint NOT NULL,
  `mes` tinyint NOT NULL COMMENT '1-12, mes calendario en que vence',
  `digito_ruc` tinyint NOT NULL COMMENT '0-9, último dígito del RUC',
  `tipo_obligacion` enum('IGV_RENTA','PLANILLA','RCE_RVIE_SIRE','AFP_NET') NOT NULL,
  `fecha_limite` date NOT NULL,
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO',
  PRIMARY KEY (`id_cronograma`),
  UNIQUE KEY `uk_cronograma` (`anio`,`mes`,`digito_ruc`,`tipo_obligacion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos. Cronograma oficial SUNAT, editable cada año.';

DROP TABLE IF EXISTS `declaracion`;
CREATE TABLE `declaracion` (
  `id_declaracion` int NOT NULL AUTO_INCREMENT,
  `id_empresa` int NOT NULL,
  `periodo_anio` smallint NOT NULL COMMENT 'Año del periodo tributario declarado',
  `periodo_mes` tinyint NOT NULL COMMENT 'Mes del periodo tributario declarado (no el mes de vencimiento)',
  `tipo_obligacion` enum('IGV_RENTA','PLANILLA','RCE_RVIE_SIRE','AFP_NET') NOT NULL,
  `estado_verificacion` enum('PENDIENTE_VERIFICAR','VERIFICADO_AUTOMATICO','VERIFICADO_MANUAL','ERROR_VERIFICACION') NOT NULL DEFAULT 'PENDIENTE_VERIFICAR',
  `fecha_declaracion` datetime DEFAULT NULL,
  `constancia_archivo` varchar(500) DEFAULT NULL,
  `fuente` enum('MANUAL','AUTOMATICO') NOT NULL DEFAULT 'MANUAL',
  `mensaje_error` varchar(500) DEFAULT NULL COMMENT 'Motivo cuando estado_verificacion = ERROR_VERIFICACION',
  `fecha_ultima_verificacion` datetime DEFAULT NULL,
  `estado_pago` enum('PENDIENTE_VERIFICAR','PAGADO','NO_PAGADO','ERROR_VERIFICACION') NOT NULL DEFAULT 'PENDIENTE_VERIFICAR' COMMENT 'Alerta independiente de estado_verificacion — declarar y pagar son eventos distintos',
  `importe_pagado` decimal(12,2) DEFAULT NULL,
  `fecha_pago` datetime DEFAULT NULL,
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO',
  `id_usuario_mod` int DEFAULT NULL,
  PRIMARY KEY (`id_declaracion`),
  UNIQUE KEY `uk_declaracion` (`id_empresa`,`periodo_anio`,`periodo_mes`,`tipo_obligacion`),
  CONSTRAINT `fk_declaracion_empresa` FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos. Estado de declaración por empresa/periodo/obligación.';

DROP TABLE IF EXISTS `saldo_favor`;
CREATE TABLE `saldo_favor` (
  `id_saldo` int NOT NULL AUTO_INCREMENT,
  `id_empresa` int NOT NULL,
  `periodo_anio` smallint NOT NULL,
  `periodo_mes` tinyint NOT NULL,
  `tipo_impuesto` enum('IGV','RENTA','PERCEPCIONES','RETENCIONES') NOT NULL,
  `monto` decimal(12,2) NOT NULL DEFAULT '0.00',
  `fuente` enum('DECLARACION_OFICIAL','CORTE_PRELIMINAR') NOT NULL,
  `fecha_registro` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_saldo`),
  UNIQUE KEY `uk_saldo_favor` (`id_empresa`,`periodo_anio`,`periodo_mes`,`tipo_impuesto`,`fuente`),
  CONSTRAINT `fk_saldo_favor_empresa` FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos. Saldo a favor arrastrado por empresa/periodo/impuesto.';

DROP TABLE IF EXISTS `corte_preliminar`;
CREATE TABLE `corte_preliminar` (
  `id_corte` int NOT NULL AUTO_INCREMENT,
  `id_empresa` int NOT NULL,
  `periodo_anio` smallint NOT NULL,
  `periodo_mes` tinyint NOT NULL,
  `total_compras` decimal(12,2) NOT NULL DEFAULT '0.00',
  `total_ventas` decimal(12,2) NOT NULL DEFAULT '0.00',
  `compras_no_grabadas` decimal(12,2) NOT NULL DEFAULT '0.00',
  `resultado_igv` decimal(12,2) NOT NULL DEFAULT '0.00' COMMENT 'Positivo = importe a pagar, negativo = saldo a favor',
  `fecha_corte` datetime DEFAULT CURRENT_TIMESTAMP,
  `id_usuario_registro` int NOT NULL,
  PRIMARY KEY (`id_corte`),
  UNIQUE KEY `uk_corte_preliminar` (`id_empresa`,`periodo_anio`,`periodo_mes`),
  CONSTRAINT `fk_corte_empresa` FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE CASCADE,
  CONSTRAINT `fk_corte_usuario` FOREIGN KEY (`id_usuario_registro`) REFERENCES `sis_usuario` (`id_usuario`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos. Cálculo interno de compras/ventas antes de declarar.';

-- ---------- FASE 3: parámetros para que la IA no invente cifras tributarias ----------

DROP TABLE IF EXISTS `parametro_tributario`;
CREATE TABLE `parametro_tributario` (
  `id_parametro` int NOT NULL AUTO_INCREMENT,
  `anio` smallint NOT NULL,
  `codigo` varchar(50) NOT NULL COMMENT 'Ej: UIT, RMV, TASA_IGV, TIM',
  `valor` decimal(14,4) NOT NULL,
  `descripcion` varchar(200) DEFAULT NULL,
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO',
  PRIMARY KEY (`id_parametro`),
  UNIQUE KEY `uk_parametro_anio` (`anio`,`codigo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos/IA. Parámetros tributarios oficiales por año, para que los asistentes de IA citen el dato real y no el de su entrenamiento.';

DROP TABLE IF EXISTS `uso_ia`;
CREATE TABLE `uso_ia` (
  `id_uso` int NOT NULL AUTO_INCREMENT,
  `id_usuario` int NOT NULL,
  `asistente` varchar(50) NOT NULL COMMENT 'RESUMEN_DIARIO, DETECCION_INCONSISTENCIAS, REDACCION_CORREO',
  `tokens_entrada` int NOT NULL DEFAULT '0',
  `tokens_salida` int NOT NULL DEFAULT '0',
  `costo_estimado_usd` decimal(10,6) NOT NULL DEFAULT '0.000000',
  `fecha` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_uso`),
  KEY `fk_uso_ia_usuario` (`id_usuario`),
  KEY `idx_uso_ia_fecha` (`fecha`),
  CONSTRAINT `fk_uso_ia_usuario` FOREIGN KEY (`id_usuario`) REFERENCES `sis_usuario` (`id_usuario`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: IA. Registro de uso y costo por consulta, para los controles de gasto definidos en el brief.';

DROP TABLE IF EXISTS `credito_fiscal_sire`;
CREATE TABLE `credito_fiscal_sire` (
  `id_credito` int NOT NULL AUTO_INCREMENT,
  `id_empresa` int NOT NULL,
  `periodo_anio` smallint NOT NULL,
  `periodo_mes` tinyint NOT NULL,
  `factprorrata` decimal(14,4) DEFAULT NULL COMMENT 'Coeficiente de prorrata (FV0621)',
  `valor_rcf` decimal(14,4) DEFAULT NULL COMMENT 'Reintegro del crédito fiscal (FV0621)',
  `valor_cfe` decimal(14,4) DEFAULT NULL COMMENT 'Crédito fiscal especial (FV0621)',
  `fecha_consulta` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_credito`),
  UNIQUE KEY `uk_credito_fiscal` (`id_empresa`,`periodo_anio`,`periodo_mes`),
  CONSTRAINT `fk_credito_fiscal_empresa` FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos/Fase2. Datos crudos de la consulta FV0621 (API oficial SIRE), separado de saldo_favor porque el mapeo exacto de estos 3 campos a "monto de saldo a favor" no está confirmado — se guardan tal cual los devuelve SUNAT.';

-- ---------- Stored procedures: empresa ----------

DELIMITER ;;
CREATE PROCEDURE `empresa_crear`(
    IN p_razon_social VARCHAR(200), IN p_ruc CHAR(11), IN p_regimen VARCHAR(20),
    IN p_id_encargado_contable INT, IN p_id_encargado_laboral INT, IN p_id_usuario_crea INT
)
BEGIN
    INSERT INTO empresa (razon_social, ruc, regimen_tributario, id_encargado_contable, id_encargado_laboral, id_usuario_crea)
    VALUES (p_razon_social, p_ruc, p_regimen, p_id_encargado_contable, p_id_encargado_laboral, p_id_usuario_crea);
    SELECT LAST_INSERT_ID() AS id_insertado;
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `empresa_listar`(IN p_estado_cliente VARCHAR(20), IN p_search VARCHAR(200))
BEGIN
    SELECT e.id_empresa, e.razon_social, e.ruc, e.regimen_tributario, e.estado_cliente, e.estado_sunat,
           e.id_encargado_contable, uc.nombres AS encargado_contable_nombres,
           e.id_encargado_laboral, ul.nombres AS encargado_laboral_nombres,
           RIGHT(e.ruc, 1) AS digito_ruc
    FROM empresa e
    LEFT JOIN sis_usuario uc ON e.id_encargado_contable = uc.id_usuario
    LEFT JOIN sis_usuario ul ON e.id_encargado_laboral = ul.id_usuario
    WHERE e.estado_registro = 'ACTIVO'
      AND (p_estado_cliente IS NULL OR e.estado_cliente = p_estado_cliente)
      AND (p_search IS NULL OR p_search = '' OR e.razon_social LIKE CONCAT('%', p_search, '%') OR e.ruc LIKE CONCAT('%', p_search, '%'))
    ORDER BY e.razon_social ASC;
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `empresa_obtener`(IN p_id INT)
BEGIN
    SELECT id_empresa, razon_social, ruc, regimen_tributario, estado_cliente, estado_sunat, observaciones,
           id_encargado_contable, id_encargado_laboral, RIGHT(ruc, 1) AS digito_ruc
    FROM empresa
    WHERE id_empresa = p_id AND estado_registro = 'ACTIVO';
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `empresa_actualizar`(
    IN p_id INT, IN p_razon_social VARCHAR(200), IN p_regimen VARCHAR(20),
    IN p_estado_cliente VARCHAR(20), IN p_estado_sunat VARCHAR(20), IN p_observaciones TEXT,
    IN p_id_encargado_contable INT, IN p_id_encargado_laboral INT, IN p_id_usuario_mod INT
)
BEGIN
    UPDATE empresa SET
        razon_social = p_razon_social, regimen_tributario = p_regimen,
        estado_cliente = p_estado_cliente, estado_sunat = p_estado_sunat, observaciones = p_observaciones,
        id_encargado_contable = p_id_encargado_contable, id_encargado_laboral = p_id_encargado_laboral,
        id_usuario_mod = p_id_usuario_mod
    WHERE id_empresa = p_id;
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `empresa_eliminar`(IN p_id INT)
BEGIN
    UPDATE empresa SET estado_registro = 'ELIMINADO' WHERE id_empresa = p_id;
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `empresa_credenciales_guardar`(
    IN p_id INT,
    IN p_sol_usuario VARBINARY(255), IN p_sol_password VARBINARY(255),
    IN p_api_client_id VARBINARY(255), IN p_api_client_secret VARBINARY(255)
)
BEGIN
    -- Los valores ya llegan cifrados desde la aplicación (AES-256-GCM); esta SP nunca ve texto plano.
    UPDATE empresa SET
        sunat_sol_usuario = COALESCE(p_sol_usuario, sunat_sol_usuario),
        sunat_sol_password = COALESCE(p_sol_password, sunat_sol_password),
        sunat_api_client_id = COALESCE(p_api_client_id, sunat_api_client_id),
        sunat_api_client_secret = COALESCE(p_api_client_secret, sunat_api_client_secret)
    WHERE id_empresa = p_id;
END ;;
DELIMITER ;

-- ---------- Stored procedures: cronograma_vencimiento ----------

DELIMITER ;;
CREATE PROCEDURE `cronograma_upsert`(
    IN p_anio SMALLINT, IN p_mes TINYINT, IN p_digito TINYINT,
    IN p_tipo VARCHAR(20), IN p_fecha_limite DATE
)
BEGIN
    INSERT INTO cronograma_vencimiento (anio, mes, digito_ruc, tipo_obligacion, fecha_limite)
    VALUES (p_anio, p_mes, p_digito, p_tipo, p_fecha_limite)
    ON DUPLICATE KEY UPDATE fecha_limite = p_fecha_limite;
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `cronograma_listar`(IN p_anio SMALLINT, IN p_mes TINYINT)
BEGIN
    SELECT id_cronograma, anio, mes, digito_ruc, tipo_obligacion, fecha_limite
    FROM cronograma_vencimiento
    WHERE estado_registro = 'ACTIVO'
      AND (p_anio IS NULL OR anio = p_anio)
      AND (p_mes IS NULL OR mes = p_mes)
    ORDER BY anio ASC, mes ASC, digito_ruc ASC, tipo_obligacion ASC;
END ;;
DELIMITER ;

-- ---------- Stored procedures: declaracion (semáforo) ----------

DELIMITER ;;
CREATE PROCEDURE `declaracion_listar_periodo`(IN p_periodo_anio SMALLINT, IN p_periodo_mes TINYINT)
BEGIN
    -- Vista principal del módulo: por empresa, qué obligaciones tiene ese periodo,
    -- cruzando con el cronograma (según su dígito de RUC) y lo declarado hasta ahora.
    SELECT
        e.id_empresa, e.razon_social, e.ruc, RIGHT(e.ruc, 1) AS digito_ruc,
        e.id_encargado_contable, e.id_encargado_laboral,
        c.tipo_obligacion, c.fecha_limite,
        d.id_declaracion, d.estado_verificacion, d.fecha_declaracion, d.fuente, d.mensaje_error, d.constancia_archivo,
        d.estado_pago, d.importe_pagado, d.fecha_pago,
        CASE
            WHEN d.fecha_declaracion IS NULL AND c.fecha_limite < CURDATE() THEN 'VENCIDO'
            WHEN d.fecha_declaracion IS NULL THEN 'PENDIENTE'
            WHEN d.fecha_declaracion <= c.fecha_limite THEN 'A_TIEMPO'
            ELSE 'TARDE'
        END AS alerta_declaracion,
        -- Alerta independiente de pago (ver alerta_declaracion, que solo mira declaración):
        -- una empresa puede declarar a tiempo y seguir sin pagar, lo que sigue generando
        -- intereses moratorios aunque el semáforo de declaración esté en verde.
        CASE
            WHEN d.estado_pago = 'PAGADO' THEN 'PAGADO'
            WHEN d.estado_pago = 'ERROR_VERIFICACION' THEN 'ERROR_VERIFICACION'
            WHEN d.estado_pago = 'NO_PAGADO' AND c.fecha_limite < CURDATE() THEN 'VENCIDO_SIN_PAGAR'
            WHEN d.estado_pago = 'NO_PAGADO' THEN 'PENDIENTE_PAGO'
            ELSE 'PENDIENTE_VERIFICAR'
        END AS alerta_pago
    FROM empresa e
    JOIN cronograma_vencimiento c
        -- AFP_NET no vence por dígito de RUC: es el 5.º día hábil del mes siguiente,
        -- la MISMA fecha para todos los empleadores. Por eso su cronograma se guarda
        -- una sola vez, bajo `digito_ruc = 0`, y aquí se cruza aparte — con el JOIN
        -- por dígito, AFP solo le aparecía a las empresas con RUC terminado en 0.
        ON c.anio = p_periodo_anio AND c.mes = p_periodo_mes
        AND c.digito_ruc = IF(c.tipo_obligacion = 'AFP_NET', 0, RIGHT(e.ruc, 1))
        AND c.estado_registro = 'ACTIVO'
    LEFT JOIN declaracion d
        ON d.id_empresa = e.id_empresa AND d.periodo_anio = p_periodo_anio AND d.periodo_mes = p_periodo_mes
        AND d.tipo_obligacion = c.tipo_obligacion AND d.estado_registro = 'ACTIVO'
    WHERE e.estado_registro = 'ACTIVO' AND e.estado_cliente = 'ACTIVO'
    ORDER BY e.razon_social ASC, c.tipo_obligacion ASC;
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `declaracion_marcar_manual`(
    IN p_id_empresa INT, IN p_periodo_anio SMALLINT, IN p_periodo_mes TINYINT,
    IN p_tipo VARCHAR(20), IN p_fecha_declaracion DATETIME, IN p_constancia_archivo VARCHAR(500),
    IN p_id_usuario_mod INT
)
BEGIN
    INSERT INTO declaracion (id_empresa, periodo_anio, periodo_mes, tipo_obligacion, estado_verificacion, fecha_declaracion, constancia_archivo, fuente, id_usuario_mod)
    VALUES (p_id_empresa, p_periodo_anio, p_periodo_mes, p_tipo, 'VERIFICADO_MANUAL', p_fecha_declaracion, p_constancia_archivo, 'MANUAL', p_id_usuario_mod)
    ON DUPLICATE KEY UPDATE
        estado_verificacion = 'VERIFICADO_MANUAL',
        fecha_declaracion = p_fecha_declaracion,
        -- COALESCE, no asignación directa: re-marcar una declaración ya registrada
        -- (ej. para corregir la fecha) llegaba con la constancia en NULL y BORRABA
        -- silenciosamente el PDF ya vinculado. Si no se manda constancia, se conserva
        -- la que ya estaba; para reemplazarla se sube/escribe una nueva.
        constancia_archivo = COALESCE(NULLIF(p_constancia_archivo, ''), constancia_archivo),
        fuente = 'MANUAL',
        mensaje_error = NULL,
        id_usuario_mod = p_id_usuario_mod;
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `declaracion_marcar_automatico`(
    IN p_id_empresa INT, IN p_periodo_anio SMALLINT, IN p_periodo_mes TINYINT,
    IN p_tipo VARCHAR(20), IN p_fecha_declaracion DATETIME, IN p_constancia_archivo VARCHAR(500),
    IN p_pago_verificado TINYINT(1), IN p_importe_pagado DECIMAL(12,2), IN p_fecha_pago DATETIME
)
BEGIN
    -- Usado por el job programado de Fase 2. Si no hay fecha (aún no declaró), se registra igual el intento.
    -- Pago: `p_pago_verificado` distingue "no se consultó pago en esta pasada" (Camino A
    -- SIRE, que hoy no expone importe pagado — deja estado_pago sin tocar/PENDIENTE_VERIFICAR)
    -- de "sí se consultó y no había importe" (Camino C scraping IGV_RENTA/PLANILLA — se
    -- marca NO_PAGADO real, no un simple "todavía no se sabe").
    INSERT INTO declaracion (id_empresa, periodo_anio, periodo_mes, tipo_obligacion, estado_verificacion, fecha_declaracion, constancia_archivo, fuente, fecha_ultima_verificacion, estado_pago, importe_pagado, fecha_pago)
    VALUES (p_id_empresa, p_periodo_anio, p_periodo_mes, p_tipo,
            IF(p_fecha_declaracion IS NULL, 'PENDIENTE_VERIFICAR', 'VERIFICADO_AUTOMATICO'),
            p_fecha_declaracion, p_constancia_archivo, 'AUTOMATICO', NOW(),
            IF(p_pago_verificado = 0, 'PENDIENTE_VERIFICAR', IF(p_importe_pagado IS NULL, 'NO_PAGADO', 'PAGADO')),
            p_importe_pagado, p_fecha_pago)
    ON DUPLICATE KEY UPDATE
        -- ⚠️ ORDEN IMPORTANTE: dentro de ON DUPLICATE KEY UPDATE, una columna ya asignada
        -- devuelve su valor NUEVO. `fuente` y `fecha_declaracion` se calculan ANTES de
        -- tocar `estado_verificacion` justo para poder leer el estado ANTERIOR.
        --
        -- Una verificación automática que NO encuentra la declaración (p_fecha_declaracion
        -- NULL) no debe pisar un marcado MANUAL: el scraping del portal SUNAT es frágil
        -- (cambia de selectores) y un falso "no declarado" borraba la fecha y la constancia
        -- que cargó la persona, devolviendo la fila a rojo. Si sí la encuentra, manda lo
        -- automático, que es lo verificado contra SUNAT.
        fuente = IF(p_fecha_declaracion IS NULL AND estado_verificacion = 'VERIFICADO_MANUAL', 'MANUAL', 'AUTOMATICO'),
        fecha_declaracion = IF(p_fecha_declaracion IS NULL AND estado_verificacion = 'VERIFICADO_MANUAL', fecha_declaracion, p_fecha_declaracion),
        estado_verificacion = IF(p_fecha_declaracion IS NULL,
                                 IF(estado_verificacion = 'VERIFICADO_MANUAL', 'VERIFICADO_MANUAL', 'PENDIENTE_VERIFICAR'),
                                 'VERIFICADO_AUTOMATICO'),
        constancia_archivo = COALESCE(p_constancia_archivo, constancia_archivo),
        mensaje_error = NULL,
        fecha_ultima_verificacion = NOW(),
        estado_pago = IF(p_pago_verificado = 0, estado_pago, IF(p_importe_pagado IS NULL, 'NO_PAGADO', 'PAGADO')),
        importe_pagado = IF(p_pago_verificado = 0, importe_pagado, p_importe_pagado),
        fecha_pago = IF(p_pago_verificado = 0, fecha_pago, p_fecha_pago);
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `declaracion_marcar_error`(
    IN p_id_empresa INT, IN p_periodo_anio SMALLINT, IN p_periodo_mes TINYINT,
    IN p_tipo VARCHAR(20), IN p_mensaje_error VARCHAR(500)
)
BEGIN
    -- El scraper/API falló para esta empresa: nunca se asume "no declarado" ni "no pagado",
    -- ambas alertas quedan marcadas como error.
    INSERT INTO declaracion (id_empresa, periodo_anio, periodo_mes, tipo_obligacion, estado_verificacion, fuente, mensaje_error, fecha_ultima_verificacion, estado_pago)
    VALUES (p_id_empresa, p_periodo_anio, p_periodo_mes, p_tipo, 'ERROR_VERIFICACION', 'AUTOMATICO', p_mensaje_error, NOW(), 'ERROR_VERIFICACION')
    ON DUPLICATE KEY UPDATE
        -- ⚠️ ORDEN IMPORTANTE: una columna ya asignada devuelve su valor NUEVO dentro
        -- del ON DUPLICATE KEY UPDATE, así que todo lo que necesite leer el estado
        -- ANTERIOR va antes de reasignar `estado_verificacion`.
        --
        -- Que el robot falle no debe ensuciar el trabajo que ya hizo una persona: si la
        -- fila estaba VERIFICADO_MANUAL, se conserva tal cual (solo se anota que se
        -- intentó verificar). Antes, un scraping caído la pintaba de rojo y la sumaba al
        -- contador de "con error", aunque la declaración SÍ estuviera presentada.
        -- Igual con el pago: un PAGADO ya confirmado no se degrada a error.
        mensaje_error = IF(estado_verificacion = 'VERIFICADO_MANUAL', mensaje_error, p_mensaje_error),
        estado_pago = IF(estado_verificacion = 'VERIFICADO_MANUAL' OR estado_pago = 'PAGADO', estado_pago, 'ERROR_VERIFICACION'),
        estado_verificacion = IF(estado_verificacion = 'VERIFICADO_MANUAL', 'VERIFICADO_MANUAL', 'ERROR_VERIFICACION'),
        fecha_ultima_verificacion = NOW();
END ;;
DELIMITER ;

-- ---------- Stored procedures: credito_fiscal_sire (Fase 2, vía API oficial) ----------

DELIMITER ;;
CREATE PROCEDURE `credito_fiscal_sire_registrar`(
    IN p_id_empresa INT, IN p_periodo_anio SMALLINT, IN p_periodo_mes TINYINT,
    IN p_factprorrata DECIMAL(14,4), IN p_valor_rcf DECIMAL(14,4), IN p_valor_cfe DECIMAL(14,4)
)
BEGIN
    INSERT INTO credito_fiscal_sire (id_empresa, periodo_anio, periodo_mes, factprorrata, valor_rcf, valor_cfe)
    VALUES (p_id_empresa, p_periodo_anio, p_periodo_mes, p_factprorrata, p_valor_rcf, p_valor_cfe)
    ON DUPLICATE KEY UPDATE
        factprorrata = p_factprorrata, valor_rcf = p_valor_rcf, valor_cfe = p_valor_cfe,
        fecha_consulta = CURRENT_TIMESTAMP;
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `credito_fiscal_sire_por_empresa`(IN p_id_empresa INT)
BEGIN
    SELECT periodo_anio, periodo_mes, factprorrata, valor_rcf, valor_cfe, fecha_consulta
    FROM credito_fiscal_sire
    WHERE id_empresa = p_id_empresa
    ORDER BY periodo_anio DESC, periodo_mes DESC;
END ;;
DELIMITER ;

-- ---------- Stored procedures: saldo_favor y corte_preliminar ----------

DELIMITER ;;
CREATE PROCEDURE `saldo_favor_registrar`(
    IN p_id_empresa INT, IN p_periodo_anio SMALLINT, IN p_periodo_mes TINYINT,
    IN p_tipo_impuesto VARCHAR(20), IN p_monto DECIMAL(12,2), IN p_fuente VARCHAR(20)
)
BEGIN
    INSERT INTO saldo_favor (id_empresa, periodo_anio, periodo_mes, tipo_impuesto, monto, fuente)
    VALUES (p_id_empresa, p_periodo_anio, p_periodo_mes, p_tipo_impuesto, p_monto, p_fuente)
    ON DUPLICATE KEY UPDATE monto = p_monto, fecha_registro = CURRENT_TIMESTAMP;
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `saldo_favor_por_empresa`(IN p_id_empresa INT)
BEGIN
    SELECT periodo_anio, periodo_mes, tipo_impuesto, monto, fuente, fecha_registro
    FROM saldo_favor
    WHERE id_empresa = p_id_empresa
    ORDER BY periodo_anio DESC, periodo_mes DESC;
END ;;
DELIMITER ;

DELIMITER ;;
CREATE PROCEDURE `corte_preliminar_registrar`(
    IN p_id_empresa INT, IN p_periodo_anio SMALLINT, IN p_periodo_mes TINYINT,
    IN p_total_compras DECIMAL(12,2), IN p_total_ventas DECIMAL(12,2),
    IN p_compras_no_grabadas DECIMAL(12,2), IN p_resultado_igv DECIMAL(12,2),
    IN p_id_usuario_registro INT
)
BEGIN
    INSERT INTO corte_preliminar (id_empresa, periodo_anio, periodo_mes, total_compras, total_ventas, compras_no_grabadas, resultado_igv, id_usuario_registro)
    VALUES (p_id_empresa, p_periodo_anio, p_periodo_mes, p_total_compras, p_total_ventas, p_compras_no_grabadas, p_resultado_igv, p_id_usuario_registro)
    ON DUPLICATE KEY UPDATE
        total_compras = p_total_compras, total_ventas = p_total_ventas,
        compras_no_grabadas = p_compras_no_grabadas, resultado_igv = p_resultado_igv,
        fecha_corte = CURRENT_TIMESTAMP, id_usuario_registro = p_id_usuario_registro;
END ;;
DELIMITER ;

-- ---------- Permisos: módulos VENCIMIENTOS_TRIBUTARIO y VENCIMIENTOS_LABORAL ----------
-- Separados en dos módulos reales (no un solo módulo con dos permisos mezclados): el equipo
-- tributario (IGV/Renta/RCE-RVIE-SIRE) y el equipo laboral (Planilla/AFP) son áreas distintas
-- del estudio, con encargados distintos (empresa.id_encargado_contable / id_encargado_laboral),
-- así que cada uno aparece como fila propia en la matriz de permisos y en el sidebar.

INSERT INTO `sis_modulo` (`nombre`, `etiqueta`, `estado_registro`) VALUES
('VENCIMIENTOS_TRIBUTARIO', 'Vencimientos - Tributario', 'ACTIVO'),
('VENCIMIENTOS_LABORAL', 'Vencimientos - Laboral', 'ACTIVO');

SET @id_modulo_vencimientos = (SELECT id_modulo FROM sis_modulo WHERE nombre = 'VENCIMIENTOS_TRIBUTARIO');
SET @id_modulo_vencimientos_laboral = (SELECT id_modulo FROM sis_modulo WHERE nombre = 'VENCIMIENTOS_LABORAL');

INSERT INTO `sis_accion` (`id_modulo`, `codigo_accion`, `descripcion`, `tipo_operacion`, `estado_registro`) VALUES
(@id_modulo_vencimientos, 'ver_vencimiento_tributario', 'Ver el estado de IGV-Renta y RCE/RVIE/SIRE de todas las empresas', 'READ', 'ACTIVO'),
(@id_modulo_vencimientos, 'crear_empresa', 'Registrar una nueva empresa cliente', 'CREATE', 'ACTIVO'),
(@id_modulo_vencimientos, 'editar_empresa', 'Editar datos de una empresa cliente', 'UPDATE', 'ACTIVO'),
(@id_modulo_vencimientos, 'eliminar_empresa', 'Dar de baja una empresa cliente', 'DELETE', 'ACTIVO'),
(@id_modulo_vencimientos, 'editar_encargado', 'Reasignar el encargado contable o laboral de una empresa', 'UPDATE', 'ACTIVO'),
(@id_modulo_vencimientos, 'marcar_declaracion', 'Marcar una declaración tributaria como presentada (manual)', 'UPDATE', 'ACTIVO'),
(@id_modulo_vencimientos, 'editar_cronograma', 'Editar el cronograma de vencimientos SUNAT', 'UPDATE', 'ACTIVO'),
(@id_modulo_vencimientos, 'ver_corte_preliminar', 'Ver el cálculo interno de compras/ventas', 'READ', 'ACTIVO'),
(@id_modulo_vencimientos, 'editar_corte_preliminar', 'Registrar el cálculo interno de compras/ventas', 'UPDATE', 'ACTIVO'),
(@id_modulo_vencimientos, 'ver_saldo_favor', 'Ver el saldo a favor arrastrado por empresa', 'READ', 'ACTIVO'),
(@id_modulo_vencimientos, 'ver_credenciales_sunat', 'Ver/editar credenciales SUNAT de una empresa (dato sensible)', 'SPECIAL', 'ACTIVO'),
(@id_modulo_vencimientos, 'usar_asistente_ia', 'Usar los asistentes de IA (resumen diario, detección de inconsistencias, redacción de correos)', 'SPECIAL', 'ACTIVO'),
(@id_modulo_vencimientos, 'exportar_pdf_vencimientos', 'Exportar a PDF el semáforo de vencimientos tributarios', 'READ', 'ACTIVO'),
(@id_modulo_vencimientos_laboral, 'ver_vencimiento_laboral', 'Ver el estado de Planilla/AFP de todas las empresas', 'READ', 'ACTIVO'),
(@id_modulo_vencimientos_laboral, 'marcar_declaracion_laboral', 'Marcar una declaración de Planilla/AFP como presentada (manual)', 'UPDATE', 'ACTIVO'),
(@id_modulo_vencimientos_laboral, 'exportar_pdf_vencimientos_laboral', 'Exportar a PDF el semáforo de vencimientos laborales', 'READ', 'ACTIVO');

-- El único rol existente hoy (SUPERADMIN) recibe todos los permisos nuevos.
INSERT INTO `sis_permiso` (`id_rol`, `id_accion`, `estado_registro`)
SELECT 1, id_accion, 'ACTIVO' FROM sis_accion WHERE id_modulo IN (@id_modulo_vencimientos, @id_modulo_vencimientos_laboral);

-- ---------- Permisos: módulos core USUARIOS y SEGURIDAD ----------
-- Los controllers (usuarios.controller.ts, seguridad.controller.ts) ya exigían estos códigos
-- vía @RequirePermissions, y el frontend ya tiene los ítems de menú (menu.config.ts) gateados
-- por 'ver_usuario'/'ver_seguridad', pero nunca se habían insertado en sis_modulo/sis_accion —
-- por eso ni el propio SUPERADMIN veía "Usuarios"/"Permisos" en el sidebar (sin la fila en
-- sis_accion, el permiso no existe para nadie, sin importar el rol).

INSERT INTO `sis_modulo` (`nombre`, `etiqueta`, `estado_registro`) VALUES
('USUARIOS', 'Usuarios', 'ACTIVO'),
('SEGURIDAD', 'Permisos', 'ACTIVO');

SET @id_modulo_usuarios = (SELECT id_modulo FROM sis_modulo WHERE nombre = 'USUARIOS');
SET @id_modulo_seguridad = (SELECT id_modulo FROM sis_modulo WHERE nombre = 'SEGURIDAD');

INSERT INTO `sis_accion` (`id_modulo`, `codigo_accion`, `descripcion`, `tipo_operacion`, `estado_registro`) VALUES
(@id_modulo_usuarios, 'ver_usuario', 'Ver el listado de usuarios del sistema', 'READ', 'ACTIVO'),
(@id_modulo_usuarios, 'crear_usuario', 'Registrar un nuevo usuario', 'CREATE', 'ACTIVO'),
(@id_modulo_usuarios, 'actualizar_usuario', 'Editar datos de un usuario', 'UPDATE', 'ACTIVO'),
(@id_modulo_usuarios, 'eliminar_usuario', 'Dar de baja a un usuario', 'DELETE', 'ACTIVO'),
(@id_modulo_seguridad, 'ver_seguridad', 'Ver roles y la matriz de permisos', 'READ', 'ACTIVO'),
(@id_modulo_seguridad, 'crear_seguridad', 'Crear un nuevo rol', 'CREATE', 'ACTIVO'),
(@id_modulo_seguridad, 'actualizar_seguridad', 'Editar un rol o su matriz de permisos', 'UPDATE', 'ACTIVO'),
(@id_modulo_seguridad, 'eliminar_seguridad', 'Eliminar un rol', 'DELETE', 'ACTIVO');

INSERT INTO `sis_permiso` (`id_rol`, `id_accion`, `estado_registro`)
SELECT 1, id_accion, 'ACTIVO' FROM sis_accion WHERE id_modulo IN (@id_modulo_usuarios, @id_modulo_seguridad);

-- ---------- Módulo CONFIGURACIONES — guías de navegación manual (SUNAT y lo que venga) ----------
-- Nace porque el equipo necesita repetir a mano, de vez en cuando, el mismo recorrido de
-- clics en el portal de SUNAT (login → menú → formulario → descarga) para verificar algo
-- puntual sin usar el robot automatizado. En vez de que un desarrollador la codifique cada
-- vez que aparece un formulario nuevo (0621, 0601, y los que sigan), cualquier usuario con
-- permiso puede crear/editar sus propias guías desde la UI.
DROP TABLE IF EXISTS `guias_sunat`;
CREATE TABLE `guias_sunat` (
  `id_guia` int NOT NULL AUTO_INCREMENT,
  `codigo` varchar(20) NOT NULL COMMENT 'Código del formulario o trámite, ej: 0621, 0601',
  `nombre` varchar(255) NOT NULL COMMENT 'Nombre legible, ej: IGV - Renta Mensual (PDT 621)',
  `pasos` text NOT NULL COMMENT 'Pasos de navegación en orden, uno por línea',
  `estado` enum('ACTIVO','INACTIVO') NOT NULL DEFAULT 'ACTIVO' COMMENT 'Soft delete',
  `id_usuario_crea` int NOT NULL,
  `id_usuario_mod` int DEFAULT NULL,
  PRIMARY KEY (`id_guia`),
  UNIQUE KEY `uk_codigo_guia` (`codigo`),
  KEY `fk_guias_sunat_usuario_crea` (`id_usuario_crea`),
  KEY `fk_guias_sunat_usuario_mod` (`id_usuario_mod`),
  CONSTRAINT `fk_guias_sunat_usuario_crea` FOREIGN KEY (`id_usuario_crea`) REFERENCES `sis_usuario` (`id_usuario`),
  CONSTRAINT `fk_guias_sunat_usuario_mod` FOREIGN KEY (`id_usuario_mod`) REFERENCES `sis_usuario` (`id_usuario`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Configuraciones. Guías de navegación manual para portales externos.';

INSERT INTO `sis_modulo` (`nombre`, `etiqueta`, `estado_registro`) VALUES
('CONFIGURACIONES', 'Configuraciones', 'ACTIVO');

SET @id_modulo_configuraciones = (SELECT id_modulo FROM sis_modulo WHERE nombre = 'CONFIGURACIONES');

INSERT INTO `sis_accion` (`id_modulo`, `codigo_accion`, `descripcion`, `tipo_operacion`, `estado_registro`) VALUES
(@id_modulo_configuraciones, 'ver_guias_sunat', 'Ver las guías de navegación manual de SUNAT', 'READ', 'ACTIVO'),
(@id_modulo_configuraciones, 'crear_guia_sunat', 'Crear una guía de navegación SUNAT', 'CREATE', 'ACTIVO'),
(@id_modulo_configuraciones, 'editar_guia_sunat', 'Editar una guía de navegación SUNAT', 'UPDATE', 'ACTIVO'),
(@id_modulo_configuraciones, 'eliminar_guia_sunat', 'Eliminar una guía de navegación SUNAT', 'DELETE', 'ACTIVO');

INSERT INTO `sis_permiso` (`id_rol`, `id_accion`, `estado_registro`)
SELECT 1, id_accion, 'ACTIVO' FROM sis_accion WHERE id_modulo = @id_modulo_configuraciones;

-- ---------- SIRE (RVIE/RCE) — portado de YUNTA-ERP, adaptado a multi-empresa ----------
-- Conexión directa a la API oficial de SUNAT (OAuth2), no scraping. Cada descarga
-- pertenece a una empresa CLIENTE (`id_empresa`), a diferencia de YUNTA-ERP donde había
-- una sola empresa dueña del sistema. Las credenciales SIRE ya viven en `empresa`
-- (`sunat_sol_usuario`/`sunat_sol_password`/`sunat_api_client_id`/`sunat_api_client_secret`,
-- ver arriba en la definición de esa tabla) — no hace falta ninguna tabla nueva de
-- credenciales, solo el historial de tickets/descargas.
DROP TABLE IF EXISTS `sire_descarga`;
CREATE TABLE `sire_descarga` (
  `id_descarga` int NOT NULL AUTO_INCREMENT,
  `id_empresa` int NOT NULL COMMENT 'Empresa cliente dueña de esta descarga SIRE',
  `tipo_libro` enum('RVIE','RCE') NOT NULL,
  `periodo` varchar(6) NOT NULL COMMENT 'AAAAMM',
  `ticket` varchar(50) DEFAULT NULL,
  `estado_ticket` enum('GENERADO','EN_PROCESO','TERMINADO','ERROR') NOT NULL DEFAULT 'GENERADO',
  `nombre_archivo_sunat` varchar(255) DEFAULT NULL,
  `cod_tipo_archivo_reporte` varchar(10) DEFAULT NULL,
  `cod_proceso` varchar(10) DEFAULT NULL,
  `archivo_ruta` varchar(255) DEFAULT NULL COMMENT 'Relativa a storage-privado/ (NUNCA uploads/, no es pública)',
  `respuesta_cruda_json` json DEFAULT NULL,
  `fecha_generacion` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `fecha_descarga` datetime DEFAULT NULL,
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO',
  `id_usuario_crea` int NOT NULL,
  PRIMARY KEY (`id_descarga`),
  KEY `fk_sire_descarga_empresa` (`id_empresa`),
  KEY `fk_sire_descarga_usuario` (`id_usuario_crea`),
  CONSTRAINT `fk_sire_descarga_empresa` FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE CASCADE,
  CONSTRAINT `fk_sire_descarga_usuario` FOREIGN KEY (`id_usuario_crea`) REFERENCES `sis_usuario` (`id_usuario`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos Tributario. Tickets y archivos SIRE (RVIE/RCE) descargados de SUNAT por empresa cliente.';

SET @id_modulo_vencimientos_sire = (SELECT id_modulo FROM sis_modulo WHERE nombre = 'VENCIMIENTOS_TRIBUTARIO');

INSERT INTO `sis_accion` (`id_modulo`, `codigo_accion`, `descripcion`, `tipo_operacion`, `estado_registro`) VALUES
(@id_modulo_vencimientos_sire, 'usar_sire', 'Probar conexión SIRE con SUNAT para una empresa', 'SPECIAL', 'ACTIVO'),
(@id_modulo_vencimientos_sire, 'ver_sire_descarga', 'Ver el historial de descargas SIRE (RVIE/RCE) y su detalle', 'READ', 'ACTIVO'),
(@id_modulo_vencimientos_sire, 'generar_sire_descarga', 'Generar tickets SIRE y traer archivos de SUNAT', 'CREATE', 'ACTIVO');

INSERT INTO `sis_permiso` (`id_rol`, `id_accion`, `estado_registro`)
SELECT 1, id_accion, 'ACTIVO' FROM sis_accion
WHERE id_modulo = @id_modulo_vencimientos_sire AND codigo_accion IN ('usar_sire', 'ver_sire_descarga', 'generar_sire_descarga');

-- ---------- Seguimiento del registro automatizado de credenciales SIRE (client_id/secret) ----------
-- No guarda el client_id/secret en sí — eso ya vive cifrado en
-- empresa.sunat_api_client_id/sunat_api_client_secret. Esta tabla solo lleva el seguimiento
-- del proceso automatizado (Playwright) que corre en tandas contra las empresas cliente: qué
-- se intentó, cuándo, si funcionó, y el error exacto si falló — para retomar por tandas sin
-- repetir empresas ya resueltas y sin perder de vista cuáles quedaron pendientes de revisión
-- manual.
DROP TABLE IF EXISTS `sire_credenciales_registro`;
CREATE TABLE `sire_credenciales_registro` (
  `id_registro` int NOT NULL AUTO_INCREMENT,
  `id_empresa` int NOT NULL,
  `estado` enum('PENDIENTE','EN_PROCESO','EXITOSO','ERROR') NOT NULL DEFAULT 'PENDIENTE',
  `mensaje_error` text DEFAULT NULL COMMENT 'Detalle si estado=ERROR, para revisión manual sin repetir el intento a ciegas',
  `fecha_intento` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Último intento (se actualiza en cada reintento)',
  `fecha_exito` datetime DEFAULT NULL,
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO',
  `id_usuario_crea` int NOT NULL COMMENT 'Quién disparó la tanda de automatización',
  PRIMARY KEY (`id_registro`),
  UNIQUE KEY `uk_sire_credenciales_registro_empresa` (`id_empresa`),
  KEY `fk_sire_credenciales_registro_usuario` (`id_usuario_crea`),
  CONSTRAINT `fk_sire_credenciales_registro_empresa` FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE CASCADE,
  CONSTRAINT `fk_sire_credenciales_registro_usuario` FOREIGN KEY (`id_usuario_crea`) REFERENCES `sis_usuario` (`id_usuario`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos Tributario. Seguimiento del registro automatizado de aplicación SIRE (client_id/secret) por empresa cliente en el portal SUNAT.';

SET @id_modulo_vencimientos_sire2 = (SELECT id_modulo FROM sis_modulo WHERE nombre = 'VENCIMIENTOS_TRIBUTARIO');

INSERT INTO `sis_accion` (`id_modulo`, `codigo_accion`, `descripcion`, `tipo_operacion`, `estado_registro`) VALUES
(@id_modulo_vencimientos_sire2, 'registrar_credenciales_sire', 'Ejecutar el registro automatizado de credenciales API SIRE en SUNAT para una o varias empresas', 'SPECIAL', 'ACTIVO');

INSERT INTO `sis_permiso` (`id_rol`, `id_accion`, `estado_registro`)
SELECT 1, id_accion, 'ACTIVO' FROM sis_accion
WHERE id_modulo = @id_modulo_vencimientos_sire2 AND codigo_accion = 'registrar_credenciales_sire';


-- ==============================================================================
-- MÓDULO CASILLA ELECTRÓNICA SUNAFIL (Vencimientos - Laboral)
-- ==============================================================================
-- SUNAFIL no publica API para la casilla electrónica: el portal
-- (https://casillaelectronica.sunafil.gob.pe/si.inbox/) es una app JSF/PrimeFaces
-- server-rendered, sin REST/JSON. Se lee por scraping con Playwright, ver
-- apps/api/src/vencimientos/sunafil/sunafil-casilla.client.ts.
--
-- Sin tabla de credenciales a propósito: el acceso de EMPLEADOR no tiene clave propia,
-- delega en la Clave SOL de SUNAT vía OAuth2 — se reutilizan empresa.sunat_sol_usuario /
-- empresa.sunat_sol_password, ya cifradas con CredencialesCryptoService.
-- ==============================================================================

-- ---------- Notificaciones depositadas por SUNAFIL en la casilla de cada empresa ----------
DROP TABLE IF EXISTS `sunafil_notificacion`;
CREATE TABLE `sunafil_notificacion` (
  `id_notificacion` int NOT NULL AUTO_INCREMENT,
  `id_empresa` int NOT NULL COMMENT 'Empresa cliente dueña de la casilla',
  `codigo_notificacion` varchar(100) DEFAULT NULL COMMENT 'Identificador que muestra SUNAFIL en la bandeja, si la fila lo trae',
  `tipo_documento` varchar(255) DEFAULT NULL COMMENT 'Ej. Resolución de Sub Intendencia, Medida de Requerimiento, Acta de Infracción',
  `asunto` varchar(500) DEFAULT NULL,
  `numero_expediente` varchar(100) DEFAULT NULL COMMENT 'Expediente del PAS / orden de inspección asociada',
  `remitente` varchar(255) DEFAULT NULL COMMENT 'Intendencia regional que emite',
  `fecha_deposito` datetime DEFAULT NULL COMMENT 'Cuándo SUNAFIL depositó el documento — desde acá corren los plazos legales',
  `leido_en_sunafil` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Si la bandeja marca la notificación como ya abierta en el portal',
  `archivo_ruta` varchar(255) DEFAULT NULL COMMENT 'Relativa a storage-privado/ (NUNCA uploads/, no es pública)',
  `datos_crudos_json` json DEFAULT NULL COMMENT 'Fila completa tal cual se leyó del portal — red de seguridad mientras los selectores del inbox no estén confirmados en vivo',
  `hash_dedupe` char(64) NOT NULL COMMENT 'SHA-256 de los campos identificatorios de la fila; hace idempotente re-sincronizar la misma bandeja',
  `estado_gestion` enum('NUEVA','EN_REVISION','ATENDIDA') NOT NULL DEFAULT 'NUEVA' COMMENT 'Seguimiento interno del estudio, independiente de si SUNAFIL la marca leída',
  `observaciones` text DEFAULT NULL COMMENT 'Nota del encargado laboral al gestionar la notificación',
  `fecha_sincronizacion` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Cuándo la trajo el sistema (no confundir con fecha_deposito)',
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO',
  `id_usuario_crea` int NOT NULL COMMENT 'Quién disparó la sincronización que la trajo',
  `id_usuario_mod` int DEFAULT NULL,
  PRIMARY KEY (`id_notificacion`),
  UNIQUE KEY `uk_sunafil_notificacion_dedupe` (`id_empresa`, `hash_dedupe`),
  KEY `fk_sunafil_notificacion_empresa` (`id_empresa`),
  KEY `fk_sunafil_notificacion_usuario` (`id_usuario_crea`),
  KEY `ix_sunafil_notificacion_gestion` (`id_empresa`, `estado_gestion`, `fecha_deposito`),
  CONSTRAINT `fk_sunafil_notificacion_empresa` FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE CASCADE,
  CONSTRAINT `fk_sunafil_notificacion_usuario` FOREIGN KEY (`id_usuario_crea`) REFERENCES `sis_usuario` (`id_usuario`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos Laboral. Notificaciones leídas de la casilla electrónica de SUNAFIL por empresa cliente.';

-- ---------- Bitácora de cada corrida de sincronización ----------
-- El scraping contra SUNAFIL puede fallar por mil motivos ajenos al sistema (Clave SOL
-- cambiada, portal caído, rediseño del inbox, WAF). Igual que la regla de oro de Fase 2:
-- si falla una empresa NUNCA se asume "sin notificaciones" — queda el error registrado
-- acá con su motivo y el resto de empresas sigue procesándose.
DROP TABLE IF EXISTS `sunafil_sincronizacion`;
CREATE TABLE `sunafil_sincronizacion` (
  `id_sincronizacion` int NOT NULL AUTO_INCREMENT,
  `id_empresa` int NOT NULL,
  `estado` enum('EN_PROCESO','EXITOSO','ERROR') NOT NULL DEFAULT 'EN_PROCESO',
  `cantidad_leidas` int NOT NULL DEFAULT 0 COMMENT 'Filas encontradas en la bandeja',
  `cantidad_nuevas` int NOT NULL DEFAULT 0 COMMENT 'Cuántas de esas no existían todavía en sunafil_notificacion',
  `mensaje_error` text DEFAULT NULL COMMENT 'Detalle si estado=ERROR, para revisión manual sin repetir el intento a ciegas',
  `fecha_inicio` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `fecha_fin` datetime DEFAULT NULL,
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO',
  `id_usuario_crea` int NOT NULL,
  PRIMARY KEY (`id_sincronizacion`),
  KEY `fk_sunafil_sincronizacion_empresa` (`id_empresa`),
  KEY `fk_sunafil_sincronizacion_usuario` (`id_usuario_crea`),
  CONSTRAINT `fk_sunafil_sincronizacion_empresa` FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE CASCADE,
  CONSTRAINT `fk_sunafil_sincronizacion_usuario` FOREIGN KEY (`id_usuario_crea`) REFERENCES `sis_usuario` (`id_usuario`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos Laboral. Bitácora de cada corrida de lectura de la casilla SUNAFIL.';

-- ---------- Permisos ----------
-- Van sobre VENCIMIENTOS_LABORAL: SUNAFIL es fiscalización laboral, no tributaria.
SET @id_modulo_vencimientos_laboral_sunafil = (SELECT id_modulo FROM sis_modulo WHERE nombre = 'VENCIMIENTOS_LABORAL');

INSERT INTO `sis_accion` (`id_modulo`, `codigo_accion`, `descripcion`, `tipo_operacion`, `estado_registro`) VALUES
(@id_modulo_vencimientos_laboral_sunafil, 'ver_casilla_sunafil', 'Ver las notificaciones de la casilla electrónica SUNAFIL de las empresas cliente', 'READ', 'ACTIVO'),
(@id_modulo_vencimientos_laboral_sunafil, 'sincronizar_casilla_sunafil', 'Leer la casilla electrónica SUNAFIL de una empresa contra el portal real', 'SPECIAL', 'ACTIVO'),
(@id_modulo_vencimientos_laboral_sunafil, 'gestionar_casilla_sunafil', 'Marcar una notificación SUNAFIL como en revisión o atendida', 'UPDATE', 'ACTIVO');

INSERT INTO `sis_permiso` (`id_rol`, `id_accion`, `estado_registro`)
SELECT 1, id_accion, 'ACTIVO' FROM sis_accion
WHERE id_modulo = @id_modulo_vencimientos_laboral_sunafil
  AND codigo_accion IN ('ver_casilla_sunafil', 'sincronizar_casilla_sunafil', 'gestionar_casilla_sunafil');


-- ==============================================================================
-- MÓDULO BUZÓN ELECTRÓNICO SUNAT (Vencimientos - Tributario)
-- ==============================================================================
-- CONTEXTO — por qué scraping y no API (investigado 21/08/2026):
-- SUNAT sí publica APIs REST oficiales para varias cosas (SIRE/RVIE-RCE con
-- client_id/secret vía `api-seguridad.sunat.gob.pe`, CPE, padrón RUC), pero para
-- BUZÓN ELECTRÓNICO / notificaciones SOL **no existe API pública ni manual de
-- servicio web**: toda la documentación oficial (orientacion.sunat.gob.pe/6619,
-- gob.pe/7880) solo describe el portal web y las apps móviles. Lo único
-- programático que ofrece SUNAT es el AVISO por correo (gob.pe/7878), que informa
-- "tienes una notificación" pero no trae contenido ni el PDF, así que no sirve
-- para poblar esta tabla. Los productos que lo automatizan (BuzOne y similares)
-- lo hacen scrapeando el portal.
--
-- ✅ VERIFICADO CONTRA LOS SERVIDORES REALES (21/08/2026, sin usar Clave SOL de
-- ningún cliente): la aplicación del buzón está desplegada en WebLogic bajo
-- `https://ww1.sunat.gob.pe/ol-ti-itbuzon/` — ese contexto responde 403 del propio
-- WebLogic (existe, exige sesión), mientras que los nombres alternativos probados
-- (ol-ti-itnotifica, ol-ti-itbuzonsol, ol-ti-itconsultanotificacion, etc.) los
-- rechaza el nginx de borde con 404, o sea ni siquiera están desplegados.
--
-- Igual que SIRE y SUNAFIL, este módulo NO tiene tablas de credenciales: se
-- reutilizan `empresa.sunat_sol_usuario` / `empresa.sunat_sol_password`, ya
-- cifradas en aplicación con `CredencialesCryptoService` (AES-256-GCM).
-- Este archivo es la ÚNICA fuente del esquema del módulo: no hay migración suelta
-- en bd/ para el buzón (a diferencia de la casilla SUNAFIL). Para aplicarlo sobre una
-- base YA cargada, copiar de acá el bloque de este módulo — nunca correr bd.sql
-- completo en producción, hace DROP TABLE y perdería los datos.
-- ==============================================================================

-- ---------- Notificaciones depositadas por SUNAT en el buzón de cada empresa ----------
DROP TABLE IF EXISTS `sunat_buzon_notificacion`;
CREATE TABLE `sunat_buzon_notificacion` (
  `id_notificacion` int NOT NULL AUTO_INCREMENT,
  `id_empresa` int NOT NULL COMMENT 'Empresa cliente dueña del buzón',
  `bandeja` varchar(100) DEFAULT NULL COMMENT 'Carpeta/pestaña del buzón donde apareció (Notificaciones SOL, Avisos, Comunicaciones)',
  `codigo_notificacion` varchar(100) DEFAULT NULL COMMENT 'Código/N° de notificación que muestra el buzón, si la fila lo trae',
  `tipo_documento` varchar(255) DEFAULT NULL COMMENT 'Ej. Orden de Pago, Resolución de Multa, Resolución de Ejecución Coactiva, Esquela, Carta',
  `numero_documento` varchar(100) DEFAULT NULL COMMENT 'N° del acto administrativo notificado (distinto del código de la notificación)',
  `asunto` varchar(500) DEFAULT NULL,
  `dependencia` varchar(255) DEFAULT NULL COMMENT 'Intendencia/dependencia de SUNAT que emite',
  `fecha_deposito` datetime DEFAULT NULL COMMENT 'Cuándo SUNAT depositó el documento en el buzón — la notificación surte efecto el día hábil siguiente, desde ahí corren los plazos',
  `leido_en_sunat` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Si la bandeja marca la notificación como ya abierta en el portal. OJO: el plazo legal NO depende de esto, corre desde fecha_deposito',
  `archivo_ruta` varchar(255) DEFAULT NULL COMMENT 'Relativa a storage-privado/ (NUNCA uploads/, no es pública). Sin usar todavía: esta fase solo lista, no descarga adjuntos',
  `datos_crudos_json` json DEFAULT NULL COMMENT 'Fila completa tal cual se leyó del portal — red de seguridad mientras los selectores del buzón no estén confirmados en vivo',
  `hash_dedupe` char(64) NOT NULL COMMENT 'SHA-256 de los campos identificatorios de la fila; hace idempotente re-sincronizar el mismo buzón',
  `estado_gestion` enum('NUEVA','EN_REVISION','ATENDIDA') NOT NULL DEFAULT 'NUEVA' COMMENT 'Seguimiento interno del estudio, independiente de si SUNAT la marca leída',
  `observaciones` text DEFAULT NULL COMMENT 'Nota del encargado tributario al gestionar la notificación',
  `fecha_sincronizacion` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Cuándo la trajo el sistema (no confundir con fecha_deposito)',
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO',
  `id_usuario_crea` int NOT NULL COMMENT 'Quién disparó la sincronización que la trajo',
  `id_usuario_mod` int DEFAULT NULL,
  PRIMARY KEY (`id_notificacion`),
  UNIQUE KEY `uk_sunat_buzon_notificacion_dedupe` (`id_empresa`, `hash_dedupe`),
  KEY `fk_sunat_buzon_notificacion_empresa` (`id_empresa`),
  KEY `fk_sunat_buzon_notificacion_usuario` (`id_usuario_crea`),
  KEY `ix_sunat_buzon_notificacion_gestion` (`id_empresa`, `estado_gestion`, `fecha_deposito`),
  CONSTRAINT `fk_sunat_buzon_notificacion_empresa` FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE CASCADE,
  CONSTRAINT `fk_sunat_buzon_notificacion_usuario` FOREIGN KEY (`id_usuario_crea`) REFERENCES `sis_usuario` (`id_usuario`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos Tributario. Notificaciones leídas del Buzón Electrónico de SUNAT por empresa cliente.';

-- ---------- Bitácora de cada corrida de sincronización ----------
-- Misma regla de oro que Fase 2 y que SUNAFIL: si falla una empresa NUNCA se asume
-- "sin notificaciones" — queda el error registrado acá con su motivo y el resto de
-- empresas sigue procesándose.
DROP TABLE IF EXISTS `sunat_buzon_sincronizacion`;
CREATE TABLE `sunat_buzon_sincronizacion` (
  `id_sincronizacion` int NOT NULL AUTO_INCREMENT,
  `id_empresa` int NOT NULL,
  `estado` enum('EN_PROCESO','EXITOSO','ERROR') NOT NULL DEFAULT 'EN_PROCESO',
  `cantidad_leidas` int NOT NULL DEFAULT 0 COMMENT 'Filas encontradas en el buzón',
  `cantidad_nuevas` int NOT NULL DEFAULT 0 COMMENT 'Cuántas de esas no existían todavía en sunat_buzon_notificacion',
  `mensaje_error` text DEFAULT NULL COMMENT 'Detalle si estado=ERROR, para revisión manual sin repetir el intento a ciegas',
  `fecha_inicio` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `fecha_fin` datetime DEFAULT NULL,
  `estado_registro` enum('ACTIVO','ELIMINADO') NOT NULL DEFAULT 'ACTIVO',
  `id_usuario_crea` int NOT NULL,
  PRIMARY KEY (`id_sincronizacion`),
  KEY `fk_sunat_buzon_sincronizacion_empresa` (`id_empresa`),
  KEY `fk_sunat_buzon_sincronizacion_usuario` (`id_usuario_crea`),
  KEY `ix_sunat_buzon_sincronizacion_empresa_fecha` (`id_empresa`, `fecha_inicio`),
  CONSTRAINT `fk_sunat_buzon_sincronizacion_empresa` FOREIGN KEY (`id_empresa`) REFERENCES `empresa` (`id_empresa`) ON DELETE CASCADE,
  CONSTRAINT `fk_sunat_buzon_sincronizacion_usuario` FOREIGN KEY (`id_usuario_crea`) REFERENCES `sis_usuario` (`id_usuario`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MÓDULO: Vencimientos Tributario. Bitácora de cada corrida de lectura del Buzón Electrónico de SUNAT.';

-- ---------- Permisos ----------
-- Van sobre VENCIMIENTOS_TRIBUTARIO (a diferencia de la casilla SUNAFIL, que es
-- fiscalización laboral): el buzón SOL notifica actos tributarios.
SET @id_modulo_vencimientos_tributario_buzon = (SELECT id_modulo FROM sis_modulo WHERE nombre = 'VENCIMIENTOS_TRIBUTARIO');

INSERT INTO `sis_accion` (`id_modulo`, `codigo_accion`, `descripcion`, `tipo_operacion`, `estado_registro`) VALUES
(@id_modulo_vencimientos_tributario_buzon, 'ver_buzon_sunat', 'Ver las notificaciones del Buzón Electrónico SUNAT de las empresas cliente', 'READ', 'ACTIVO'),
(@id_modulo_vencimientos_tributario_buzon, 'sincronizar_buzon_sunat', 'Leer el Buzón Electrónico SUNAT de una empresa contra el portal real', 'SPECIAL', 'ACTIVO'),
(@id_modulo_vencimientos_tributario_buzon, 'gestionar_buzon_sunat', 'Marcar una notificación del buzón SUNAT como en revisión o atendida', 'UPDATE', 'ACTIVO');

INSERT INTO `sis_permiso` (`id_rol`, `id_accion`, `estado_registro`)
SELECT 1, id_accion, 'ACTIVO' FROM sis_accion
WHERE id_modulo = @id_modulo_vencimientos_tributario_buzon
  AND codigo_accion IN ('ver_buzon_sunat', 'sincronizar_buzon_sunat', 'gestionar_buzon_sunat');


-- ==============================================================================
-- DATOS REALES — usuario admin, 171 empresas y cronograma 2026, migrados desde
-- "Control de Vencimientos_EBA.xlsm". Todo integrado en este mismo archivo para
-- que baste con correr bd.sql una sola vez.
-- ==============================================================================

INSERT INTO sis_rol (id_rol, nombre, descripcion, estado_registro)
VALUES (1, 'SUPERADMIN', 'Acceso total al sistema - Administrador General', 'ACTIVO');

INSERT INTO sis_usuario (id_usuario, id_rol, nombres, apellidos, correo, password, estado_registro)
VALUES (1, 1, 'Administrador', 'Sistema', 'admin@gmail.com', '$2b$10$PqLariVCZh7HGDVF5PWDFeJG2m2guCNlhqf72hKjBiBn.Fbr8zDKO', 'ACTIVO');
-- Hash generado con bcrypt.hashSync('123456', 10), verificado en esta sesión.

-- Guías iniciales reconstruidas en vivo (16/08/2026) de los selectores verificados en
-- sunat-scraping.client.ts — mismo recorrido para ambos formularios, solo cambia el
-- valor elegido en "Número de Formulario" (paso 6).
INSERT INTO guias_sunat (codigo, nombre, pasos, estado, id_usuario_crea) VALUES
('0621', 'IGV - Renta Mensual (PDT 621)',
'1. Entrar a https://www.sunat.gob.pe/sol.html
2. Clic en "Mis Declaraciones y Pagos" (abre una ventana nueva)
3. En la ventana nueva, clic en "Ingresar por RUC"
4. Llenar RUC + Usuario SOL + Clave SOL, clic en "Iniciar sesión"
5. Ya logueado, ir al menú: Consultas → Consultas de Presentación y Pago → Consulta de Declaraciones y Pagos
6. En "Número de Formulario" elegir 0621 (IGV - Renta)
7. Elegir el Período Tributario (mes y año) — mismo mes en "inicio" y en "fin" para un solo periodo
8. Clic en "Buscar"
9. En la fila de resultado, clic en "Ver Constancia" (abre un modal)
10. Dentro del modal, clic en "Guardar" — ahí sí descarga el PDF',
'ACTIVO', 1),
('0601', 'Planilla Electrónica / PLAME (PDT 601)',
'1. Entrar a https://www.sunat.gob.pe/sol.html
2. Clic en "Mis Declaraciones y Pagos" (abre una ventana nueva)
3. En la ventana nueva, clic en "Ingresar por RUC"
4. Llenar RUC + Usuario SOL + Clave SOL, clic en "Iniciar sesión"
5. Ya logueado, ir al menú: Consultas → Consultas de Presentación y Pago → Consulta de Declaraciones y Pagos
6. En "Número de Formulario" elegir 0601 (Planilla)
7. Elegir el Período Tributario (mes y año) — mismo mes en "inicio" y en "fin" para un solo periodo
8. Clic en "Buscar"
9. En la fila de resultado, clic en "Ver Constancia" (abre un modal)
10. Dentro del modal, clic en "Guardar" — ahí sí descarga el PDF',
'ACTIVO', 1);

INSERT INTO empresa (razon_social, ruc, regimen_tributario, estado_cliente, estado_sunat, observaciones, id_usuario_crea) VALUES
('PARADISE TRAVEL & TOUR S.A.C.', '20543832660', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('SERVICIOS MEDICOS ALESSANDRA SAC', '20601925100', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('MY HOUSE ARQUITECTURA CONSTRUCCION Y SERVICIOS GENERALES S.A.C.', '20601776490', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('INVERSIONES E IMPORTACIONES A & J S.A.C.', '20604213470', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('EXPORTAFRUT MONTALVO SAC', '20607653560', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CHIFA YONG XING E.I.R.L.', '20603423900', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CACERES AGUIRRE ANA MARIA - MI GRANJITA', '10028057810', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('BECERRA AVALOS ESTRELLA MILAGRITOS', '10732701660', 'NRUS', 'ACTIVO', 'ACTIVO', NULL, 1),
('ASOCIACION DE VIVIENDA RESIDENCIAL SANTA BEATRIZ', '20608682750', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('AMIRA SPA E.I.R.L.', '20609740770', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('GLOBAL EXPRESS IMPORT E.I.R.L', '20607696790', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('ARANTZA', '20609883741', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('YANA RUMI MINERALS S.A.C.', '20612370461', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('VASQUEZ PAREDES AGUSTINA BETTY', '10180344131', 'RER', 'ACTIVO', 'ACTIVO', NULL, 1),
('VASQUEZ ALAYO JIOVANNA IVONNE', '10802400301', 'RER', 'ACTIVO', 'ACTIVO', NULL, 1),
('SETRATUR RAVIGG E.I.R.L.', '20600509641', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('PAN XUEQING', '15496062491', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('NOLASCO MENDEZ JOSE LUIS', '10179572601', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('MULTISERVICIOS ARANDA S.A.C.', '20603022221', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('MINI BOOK EIRL - REG. ESPECIAL', '20605283871', 'RER', 'ACTIVO', 'ACTIVO', NULL, 1),
('INVERSIONES TAVOCEL SAC', '20609662051', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('HEALTHY, SALUD, BELLEZA Y BIENESTAR E.I.R.L.', '20601178991', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('GOMEZ SANDOVAL CARMEN REYNALDO - Avic.mi Perlita', '10179661981', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('GM ARQUITECTURA E INGENIERIA S.A.C.', '20609784271', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('DISTRIBUIDORA MATIALE SAC', '20607455911', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CORPORACION FRANCO SERVICIOS Y ASOCIADOS S.A.C.', '20611084391', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CONSTRUCTORA MARRUFO M & T E.I.R.L.', '20600189931', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CHIFA LIMON E.I.R.L.', '20602265791', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CEVICHERIA CARAJITO PICANTE E.I.R.L.', '20600481721', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CENTRO MEDICO ESPECIALIZADO LABONORTE S.A.C.', '20609492091', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CELL TECHNOLOGY S.A.C.', '20613686771', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('AGREDA VILLANUEVA SANTOS', '10410100211', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('AGA CORP E.I.R.L.', '20491934671', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CS LOGISTICA SAC', '20605409491', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CHAVEZ, PRADO, MENDOZA & SALDAÑA ABOGADOS Y CONSULTORES S.A.C.', '20611075791', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CHASQUI TRANS EIRL', '20525977901', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('VELTERRA SAC', '20614891051', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('COMPEXMINIG E.I.R.L.', '20614133121', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('SOLUTIONS & INVESTMENTS', '20602653081', 'R.GENERAL', 'ACTIVO', 'ACTIVO', NULL, 1),
('DOMUS CELULAR E.I.R.L.', '20614984521', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('DELUVE S.A.C.', '20615154661', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('HOUSECOMPUTERS GAMING S.A.C.', '20608205251', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('ZEUS CONSTRUCTORES E.I.R.L.', '20611141352', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('VELA VILLANUEVA ENGSHEL ALEXIS', '10778043012', 'RER', 'ACTIVO', 'ACTIVO', NULL, 1),
('TRADING GROUP EL GRAN CHAYO S.A.C.', '20609619482', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('SHICA GAVINO ASUNCION EUSEBIO', '10403433042', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('RG TRANSPORTES Y SERVICIOS GENERALES S.A.C.', '20539814452', 'R.GENERAL', 'ACTIVO', 'ACTIVO', NULL, 1),
('REPOSTERIA DEL NORTE S.A.C.', '20607022942', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('MUÑOZ CALDERON BERTHA SUSANA - CONFIO', '10448423552', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('INVERSIONES GRUPO CHEA S.A.C.', '20611621362', 'RER', 'ACTIVO', 'ACTIVO', NULL, 1),
('INVERSIONES ASU S.A.C.', '20604936382', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('GRUPO AWA  SAC', '20613477552', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CENTRO ODONTOLOGICO CEOR S.A.C.', '20603685572', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CENTRO DE DIAGNOSTICO LABONORTE E.I.R.L.', '20608181092', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('C.N. INVERSIONES S.A.C.', '20482740562', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('101 COMPANY S.A.C.', '20607548782', 'MYPE', 'INACTIVO', 'ACTIVO', NULL, 1),
('MI GRANJITA  EIRL - RMT', '20440337393', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CORPORACION MEGAPHONE S.A.C.', '20604626553', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('VIPSACAR MULTISERVICIOS S.A.C.', '20600497473', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('TRANSPORTES E INVERSIONES MARIA DE LOS ANGELES S.A.C.', '20559806243', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('SERVICIOS GENERALES CONFIO EN CRISTO E.I.R.L.', '20602587763', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('PINEDA AUTOMOTRIZ S.A.C.', '20430177053', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('PARAKAS SURGICAL S.A.C.', '20554950923', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('ODONTOLOGIA Y TIENDA MEDICA SAC', '20607922463', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('INVERSIONES JM JUMART S.A.C.', '20560131993', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('INMOBILIARIA C & R ASOCIADOS E.I.R.L.', '20610364153', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('EXPRESO TURISMO CHAO S.A.C.', '20613460633', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('EMPRESA DE TRANSPORTES FABIAN EIRL', '20481328633', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('DERVIMED S.A.C.', '20608376373', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CORPORATIVO DAKAR DEL TRUJILLO S.A.C.', '20603237693', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CONFECCIONES HERRERA S.R.L.', '20440073043', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CASA BRENES S.A.C.', '20614199963', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CAO ZHENBIAO', '15511824483', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('BENNJUR MULTISERVICIOS E.I.R.L.', '20482552723', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('VASQUEZ HERNANDEZ JOSE GILMER', '10279661864', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('INGENIERIA Y CONSTRUCCIONES ZAVALETA S.A.C.', '20607414794', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('RX 1009 E.I.R.L', '20606791004', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('EMPRESA DE TRANSPORTES Y SERVICIOS TVH S.A.C', '20605721894', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('BARDALES MEDICAL IMPORT S.A.C.', '20606106484', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('GBG CONSTRUCTORA S.A.C', '20613014404', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('INVERSIONES ROBCE S.A.C.', '20614319594', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('SAGASTEGUI CABALLERO MARIA FERNANDA', '10716380594', 'MYPE', 'ACTIVO', 'ACTIVO', 'DRA', 1),
('GRUPO VIZOR PERU S.A.C', '20612147664', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('ZUÑIGA ESPINOZA DE MORENO ESTELA', '10413313355', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('VALDIVIA SAAVEDRA ROXANA', '10438095565', 'NRUS', 'ACTIVO', 'ACTIVO', NULL, 1),
('TRAVEL HUA TURISMO E.I.R.L', '20544929365', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('TAVARA BARBA JULIO CESAR', '10416201175', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('KM MICROBLADING BEAUTY S.A.C.', '20605212965', 'MYPE', 'ACTIVO', 'SUSPENDIDA', NULL, 1),
('GRUPO D''MATEO S.A.C.', '20605365435', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('GRUPO D´MATEO & ASOCIADOS S.A.C.', '20613736825', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('EVENTOS T.VARGAS SAC', '20612375705', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CARNICERIA CASANOVA EIRL', '20606791705', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('DISTRIBUCIONES Y REPRESENTACIONES N & C E.I.R.L.', '20603784945', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('NYC COMERCIOS E.I.R.L.', '20614322625', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('FUNDACION MARGARITA-FUNDAMARG', '20600713125', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('ESTUDIO BARBA & ASOCIADOS S.A.C.', '20610633995', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('EMPRESA DE TRANSPORTES Y SERVICIOS SANTISIMA VIRGEN DE LA PUERTA SRL', '20481610495', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('Y C MINERALES S.A.C.', '20614280205', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CAO YANTING', '15615507285', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CORPORACION DROIK S.A.C.', '20604222096', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('YUEN SAM MING WILLIAM', '10405015396', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('QUEENBAR S.A.C.', '20612420786', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('LABORATORIO SERVIDIESEL RODRIGUEZ CRUZ E.I.R.L.', '20607693316', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('INVERSIONES E IMPORTACIONES HIGH LINE S.A.C.', '20606779586', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('DONGCHENG E.I.R.L.', '20559673936', 'RER', 'ACTIVO', 'ACTIVO', NULL, 1),
('CHIFA ESTILO CHINO SAC', '20604708576', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('POLO REYES TEODORO', '10195646886', 'MYPE', 'ACTIVO', 'ACTIVO', 'REEMPLAZO DE ROMERO', 1),
('ICANAQUE CESPESDES MARCO ANTONIO', '10752265386', 'R.GENERAL', 'ACTIVO', 'BAJA_DEFINITIVA', NULL, 1),
('NEGOCIACIONES INDUSTRIALES DEL PERU S.A.C.', '20557207466', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CLINICA ZEGARRA SAC', '20439924226', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('GRAND VET SERVIIOS VETERINARIOS SAC', '20614852756', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('INVERSIONES & SERVICIOS CAFEL S.R.L.', '20482685286', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('J.J.O.Q. CONTRATISTAS GENERALES S.A.C', '20482257217', 'R.GENERAL', 'ACTIVO', 'ACTIVO', NULL, 1),
('VECA I SAC', '20481823057', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('AGROINDUSTRIAS CASARO S.A.C.', '20539949897', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('LLOVERA AUTOMATIZACION S.A.C.', '20603146817', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('AVICOLA MI PERLITA E.I.R.L', '20605580557', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('AGROMOVE S.A.C.', '20604613257', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('RAMOS CASTILLO TEOFILO JAVIER - MI GRANJITA', '10179286837', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('MEZAK E.I.RL.', '20609724057', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('MERCEDES VALVERDE ILICH ALEXANDER', '10452341617', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('LABONORTE MEDILAB CENTER E.I.R.L.', '20608146637', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('FABRICACIONES CASSAL SRL', '20480868537', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CONSTRUCTORA & INMOBILIARIA OBRACON S.A.C.', '20610946837', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CENTRO ODONTOLOGICO ESPECIALIZADO ORTHODENT S.A.C.', '20609158477', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CASA VERDE MOSHE EIRL', '20605245707', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CASA FINCA S.A.C.', '20612778117', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CAMPOS AVICOLAS PREMIUM E.I.R.L.', '20613718517', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CALVANAPON ARANA MARLENY NOEMI', '10457501507', 'RER', 'ACTIVO', 'ACTIVO', NULL, 1),
('BONIFACIO RODRIGUEZ DANNY SANTIAGO', '10429855247', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('ROBERTO BARBA ESPINOZA', '10421615387', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('ARIVALE CONTRATISTAS GENERALES E.I.R.L.', '20526265107', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('EMPRESA DE TRANSPORTES VIZOR PERU S.A.C', '20477398457', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CORPORACION VIZOR PERU S.A.C', '20615067998', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('JUPI ZAMBRANO S.A.C.', '20613228218', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('SMART HOUSE MD SAC', '20608427768', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('SERVICIO LOGISTICO BECH S.A.C.', '20612633038', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('MANRIQUE NOLE LUIS MANUEL', '15102960138', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('TRANSERVIS VIRGEN DE LA PUERTA S.A.C.', '20604565708', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('INVERSIONES PISCA S.A.C.', '20613942468', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('GRUPO LUDICUS SAC', '20611845368', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('GRUPO HEALTHY LA ESPERANZA S.A.C.', '20603781628', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('GRUPO HABITAT S.A.C.', '20612499838', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CORPORACION KING BAR S.A.C.', '20611154128', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CHIFA PANDA E.I.R.L.', '20610468048', 'RER', 'ACTIVO', 'ACTIVO', NULL, 1),
('CESPEDES ROMERO SILVIA YLIANA', '10413221558', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CENTRO ODONTOLOGICO CEOR LARCO S.A.C.', '20604393958', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('PRIME GOLF S.A.C.', '20612328138', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CANCINO NUREÑA MERITA NIRVANA - Avic Campos', '10478992128', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('AGLAEA S.A.C.', '20611680458', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('R & Z INGENIERIA, DISEÑO Y CONSTRUCCION S.A.C.', '20609337568', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('FOOD MANA ST E.I.R.L.', '20613954768', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('COMPANY PERUVIAN SECURITY S.A.C.', '20612385328', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('RENOVARE CENTRO DE DESARROLLO INFANTIL E.I.R.L.', '20610936548', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('LLANOS CAMPOS ALEX', '10160137288', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('MONCADA LOPEZ GISELA ANAMELVA', '10464707218', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('YANG GUODONG', '15481540779', 'RER', 'ACTIVO', 'ACTIVO', NULL, 1),
('VALERA REPUESTOS Y SERVICIOS S.A.C.', '20611996889', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('SAAVEDRA REYNA BACÍLICA FRANCISCA', '10178227829', 'NRUS', 'ACTIVO', 'ACTIVO', NULL, 1),
('MATIALE SAC', '20605089489', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('INVERSIONES MATIALE SAC', '20609811669', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('EXPRESO DIEZ ASES S.A.C.', '20604985049', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CORPORACION MONTERO GESTOR DE PROYECTOS INMOBILIARIOS S.A.C.', '20613608789', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('BE DREAMS PERU S.A.C.', '20613392069', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CHIFA DE CHONG SAC.', '20608331299', 'RER', 'ACTIVO', 'ACTIVO', NULL, 1),
('CHANAME VEREAU VICTORIA CECILIA', '10426900489', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CENTRO DE ANALISIS CLINICOS LABONORTE EIRL', '20525491839', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('CALLE GARCIA CINTYA', '10445244169', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('A&G TRANPSORTES Y SERVICIOS EIRL', '20530093019', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('AGROBUSINESS CASANOVA S.A.C.', '20615420159', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1),
('MAMANI LOPEZ SOFIA MARIA', '10004617229', 'MYPE', 'ACTIVO', 'ACTIVO', NULL, 1)
ON DUPLICATE KEY UPDATE razon_social = VALUES(razon_social);

-- Clave SOL de las 171 empresas, cargada y cifrada (AES-256-GCM) con la
-- CREDENCIALES_ENCRYPTION_KEY del .env de ESTE ambiente (erp-backend/.env).
-- Generado desde "Control de Vencimientos_EBA.xlsm" (hoja CLIENTES) — si cambias
-- de ambiente (ej. nube) con OTRA CREDENCIALES_ENCRYPTION_KEY, estos valores NO
-- se van a poder descifrar ahí (quedan como binario ilegible, no rompen nada,
-- pero las credenciales de ese ambiente quedarían vacías). En ese caso, regenerar
-- este bloque corriendo: node erp-backend/scripts/migrar-credenciales-sunat.js
-- (deja las 171 igual de cargadas, sin tocar bd.sql) o pedir que se regenere este
-- bloque con la llave del nuevo ambiente.
UPDATE empresa SET sunat_sol_usuario = UNHEX('94A145E7F6F877D8B2D85AFE7A71495B10881363105A80B9A050245C9A961D38BC7C581D'), sunat_sol_password = UNHEX('86330DB05570525931CF5CA296D2B02A9F01E9517E093C09E46B9ED6EBC00A82C35A6093DE64') WHERE ruc = '20543832660';
UPDATE empresa SET sunat_sol_usuario = UNHEX('DEFEA7CB4939A56129213C2B0A4DFDBE14F61A372B0974537E7304B04E5445C68BF80A21'), sunat_sol_password = UNHEX('0F48660614E04EB632802FC05025AEA4CE0D355ECD27736133B654483EFA996C279BEE2D2B') WHERE ruc = '20601925100';
UPDATE empresa SET sunat_sol_usuario = UNHEX('21ABB587EEB96F6692EB237B37A1FA490979504EB48BE1ED958610C7113797E4FECCC86D'), sunat_sol_password = UNHEX('70AC337500E13927B04EC8FB4141E515A1C94F4A8D449A3C24A64393418F4385F75B685DCA61') WHERE ruc = '20601776490';
UPDATE empresa SET sunat_sol_usuario = UNHEX('D9BDD2E5D56A655304DE113248506B01CF5E4847FFE6BBF79D50A68EF3100843E4B15876'), sunat_sol_password = UNHEX('31D4459EFDF29DED066F11440DCAFE845B4CF527C128AB9DF1F4530103633D02E1B5C71ED09728BF') WHERE ruc = '20604213470';
UPDATE empresa SET sunat_sol_usuario = UNHEX('9BCEDFF194605EB1AE4B1264D1D73CB83F9BE49F4A8591D494B2BB18D3D2645A61F35EE2'), sunat_sol_password = UNHEX('347AE0C0849CE6CF6E2E582914F7DD2AE2D3C9C5D9CB49B87276F2BBE780A5C6F7D3648B3C') WHERE ruc = '20607653560';
UPDATE empresa SET sunat_sol_usuario = UNHEX('84A7A36FA50D14546997A9C7829F1F08DD44433486DBF238B83E078ED699C80DBD34BC8B'), sunat_sol_password = UNHEX('D35EF874252EA87C641FFDBCA5B76F166ACADD53D20C21916E62E11668A15140F767CD') WHERE ruc = '20603423900';
UPDATE empresa SET sunat_sol_usuario = UNHEX('AD1005183C32BC45BADDF9DAC40C50DB5ED07344F45D0BB0CC017D9C78844791345CF13B'), sunat_sol_password = UNHEX('A2C7AA97CAFCE27E6811A061B85FD83605E6D0FF6348AE2EE7ED29BCAA4FED59BC73913325') WHERE ruc = '10028057810';
UPDATE empresa SET sunat_sol_usuario = UNHEX('B21307C0436D7A8234B41FF4D54943273D1D49D1651FB9EBE11C3A10AB19548989488940'), sunat_sol_password = UNHEX('4044E61F91B45ECAFB27C0CC0919DB2CD3E2D72BA1862858E95D1340889E060115F9A5D2215C6D') WHERE ruc = '10732701660';
UPDATE empresa SET sunat_sol_usuario = UNHEX('4E5278CA4F84FC30BB12E67D3DBCD70445861391DAB7C7CDF44D571F2A7C2704EC1AF6D5'), sunat_sol_password = UNHEX('5A51A39AFDEC6C6A678735F0C1AB8AC2C17618760B0CAA08284374FAE80C27C867FB9C1AB6B76E6468') WHERE ruc = '20608682750';
UPDATE empresa SET sunat_sol_usuario = UNHEX('AADBCF3AA07D0B7BE154977643E834F82F47D29DB393A558AF2EC84CCB3259A63FC26177'), sunat_sol_password = UNHEX('50A0C8AE7B66510B0FCA0CFD45CA9768518396C7B6BD7F550EB63517D1B52077E79E1481') WHERE ruc = '20609740770';
UPDATE empresa SET sunat_sol_usuario = UNHEX('47B0A418EE36832CECCE5ED024A6C8787542AF80D5060BA39D4B339C782737D31191B32C'), sunat_sol_password = UNHEX('556655D02186CAEC1E0A6271C368B4B10FF983E3E12C933F0FBA0DD6999D7705C7ADFA3BBBB8') WHERE ruc = '20607696790';
UPDATE empresa SET sunat_sol_usuario = UNHEX('4CA3B85CD10120E7A075BDA915806DCE44AF0B3D8FB30DD3F97C63B5949AEAF3038AC707'), sunat_sol_password = UNHEX('E7FD4D563033D9608411813BD3382B337705D93A879740DB51AD06155586A178DBA57ED8E1') WHERE ruc = '20609883741';
UPDATE empresa SET sunat_sol_usuario = UNHEX('0C6E5F5253F6760C6144EFCEF23D0559C5BC5EF6FB8A9AC87AD3EC55C66D39C697ADEDB7'), sunat_sol_password = UNHEX('F1D6B551107B2B11D8FF8022A98551A22809481DB7264C78708DD468402EBB01AD39') WHERE ruc = '20612370461';
UPDATE empresa SET sunat_sol_usuario = UNHEX('94F582984BD5B3DA2ABE54463F3B61131AC0C031D2337E8653DBE86329FC2F78818A6523'), sunat_sol_password = UNHEX('5D28BB80B4AAE2E0D7C99A2CFDA63326601997E417314DC7FD93375DB5C7BC424BABC2FB01AF') WHERE ruc = '10180344131';
UPDATE empresa SET sunat_sol_usuario = UNHEX('C144E7E997319FEE4123CADABB39B1670C93EE24D975A2B55C83C6B6A080879351EBBE01'), sunat_sol_password = UNHEX('E6353F49259524E96B16BF24C56C1D43AA09DA6B443CE6C7ED0A24B5CD1E009A012568A0') WHERE ruc = '10802400301';
UPDATE empresa SET sunat_sol_usuario = UNHEX('6B453F521C1EE41572E74D8454C2CF33B945D2BF0CC51E8C36660978D9B93C9A76677DE4'), sunat_sol_password = UNHEX('64321DE03394F20785E855902B9A9EE84F68A4B6C9525BB90C36333682CD19F67B506AD5471308EC') WHERE ruc = '20600509641';
UPDATE empresa SET sunat_sol_usuario = UNHEX('20477554FAAB70BA0101F8126B4DC7F23A02CE467366456F6D151F21C2D0DA22CFE717B8'), sunat_sol_password = UNHEX('A5B341FCB8EFB3A2D4D03DD852BA9968EF6152E4493A65950C59EA3F4652F6AB6BFE50C05F') WHERE ruc = '15496062491';
UPDATE empresa SET sunat_sol_usuario = UNHEX('4059F041DF4B53B18B2BC6E9CDFF43FB98A33B220881464C3680FD7EB53BBA946808CF6A'), sunat_sol_password = UNHEX('BF89F07E17C3FBB9CDBDD2491D37903FC0604829BE329539591E5EAA27C2C4098B997151') WHERE ruc = '10179572601';
UPDATE empresa SET sunat_sol_usuario = UNHEX('C4AF2973BCD1B719AEB259046FAC3F1DA107E2B28F04F81602A6CC28638E4214A382D9E2'), sunat_sol_password = UNHEX('DDD77A464DC0184CF8AA3ADD14508AACE02A3F5EF91559EF5F0EA353D17DE31C6B4B2933') WHERE ruc = '20603022221';
UPDATE empresa SET sunat_sol_usuario = UNHEX('FB96F02764C4D750F2D9AC6E4DE344EABD6B845597E029BFFD72136CB26C2C88DD46D13F'), sunat_sol_password = UNHEX('6F15A00426D8019A133B7FFF47E1285797A03409BF6EA2EB4C3C453166C4EBAD2ED7FC6D68407E') WHERE ruc = '20605283871';
UPDATE empresa SET sunat_sol_usuario = UNHEX('554108FDDCFE148C24A4FB342FB1192FBD8B389424930E2F270733CA99A8010CC0182C6D'), sunat_sol_password = UNHEX('6C8A4BB4F9B33776148541AE1FB6286FF31E796BD1857C18FA690B39CFBB03A0049F9B0417') WHERE ruc = '20609662051';
UPDATE empresa SET sunat_sol_usuario = UNHEX('6ED8B864B842D702C36EC60B52937A7EC04C8F7B803EB3E127E823071F294999E7259764'), sunat_sol_password = UNHEX('DB17F811069D1919A9544D3D02C33C5C5BA1F82FDF249455CDB4C61D218BF70E5C93DA9C1340419D') WHERE ruc = '20601178991';
UPDATE empresa SET sunat_sol_usuario = UNHEX('CC9A16E4AABCA999C7A62591D13729FC123FF4F961373211FAF770921B88EC9283428DD6'), sunat_sol_password = UNHEX('CB83E2357D21E2D093CD6CD61F6F3D75A46296BD0A9D24BC536ED962384445C9DBAB7819B6') WHERE ruc = '10179661981';
UPDATE empresa SET sunat_sol_usuario = UNHEX('204ADD9633D6D813BC1E3943A75D9571B34AAA503C58ACBFDCEDB3DBA899CF334031C2B9'), sunat_sol_password = UNHEX('CC01C0BF788F94354DD45DE5471ACFE3B99B00DC98376FABEDF88C07D8979B7C74CCB005DD2BAA') WHERE ruc = '20609784271';
UPDATE empresa SET sunat_sol_usuario = UNHEX('4F8FBBFBDA40D61A39BC2A8BCD1632DAB6B89B12003586510960F6EE6BF5CA3D743D0488'), sunat_sol_password = UNHEX('EABCF810CEF77CEBE50BEC79D9B00C0DE101E5381545F10BF8FCE4684BB46C3BF2482515EA') WHERE ruc = '20607455911';
UPDATE empresa SET sunat_sol_usuario = UNHEX('3C74A5683BA59B463A907007A37FADECFE8855F68C299B975F1EA86560D875A0124F9B19'), sunat_sol_password = UNHEX('E503B7DFE37A54D407E95938201EDC1E229F4C282981AA2CA6D21603BEB434D1505BA9DD81B9B1C2') WHERE ruc = '20611084391';
UPDATE empresa SET sunat_sol_usuario = UNHEX('FB0D1D9F51A1173A9334E0CC9A4B7BEFA48ADCB72442531554B1DBE12FF9B3F353BD6F63'), sunat_sol_password = UNHEX('263A3C974FD63EA6F6A0A289C8210B537F07ADB8853B7D5FABF3D927E9190B7F1DAEE308DD') WHERE ruc = '20600189931';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E8233BEDBA5F26BD32A73E91B09D2AD716454F8A6EF28E99F59EF947EA129EE1F244D3E1'), sunat_sol_password = UNHEX('63285659B6DC0A28DEBDC286B21AE6E21C9633405D6394858844A26C68E69EACC5776E46CAC8') WHERE ruc = '20602265791';
UPDATE empresa SET sunat_sol_usuario = UNHEX('AA6E6B69D21F4FC3960EEBA5AAEF4A29B1B88877A6FD538E2A37D737C4AC135CB670CF89'), sunat_sol_password = UNHEX('A58F118C16DD4017091C742301CD435076A5E35FEE48451E43AC416B17594529759C638EE907') WHERE ruc = '20600481721';
UPDATE empresa SET sunat_sol_usuario = UNHEX('A27C18BAFE08938FCFA3C213904591B21DC57B070336BB1E564F3027D2C18947EC618EED'), sunat_sol_password = UNHEX('E52F23BF02E3761739DDEAF0D1AE96910A0DCBF80AC909CAE472AE3C88EB88C8B45D121F091F4F') WHERE ruc = '20609492091';
UPDATE empresa SET sunat_sol_usuario = UNHEX('B49FC18F4BCA8840519D10DB44278B5A296BFADE428FA4404B1C12F705A5C23B5DFFC5C5'), sunat_sol_password = UNHEX('91D0FAAE2CBFD8F9F3D74DA2F7EC15DEA328AB7E092FA2929A2EE3F6C4B81B99121A0DEEDD') WHERE ruc = '20613686771';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E627C206FE9E2792C010B8624EE61E3525E745E2CAD78A72F747D9874E467C6E3B3C6A3B'), sunat_sol_password = UNHEX('B95447DE1B01B02E4FAB5D6675309BEE28CDDFD7CE5B9D91C9B6A09458E4A0374B52A30F') WHERE ruc = '10410100211';
UPDATE empresa SET sunat_sol_usuario = UNHEX('A5135CEB30349267F2079F001E2AEDE6EA48C3A0FB53613D941C88749FFB4CED43734FC6'), sunat_sol_password = UNHEX('890FCD4B5EE05CC2D083A789234D6C0F8101DCD4C4EC7BA7FE39A1CE0A15A4396D707A8D5A') WHERE ruc = '20491934671';
UPDATE empresa SET sunat_sol_usuario = UNHEX('69B9994C0D328963EABFB9619D559DA004F342F4D579E627CF7AA633C85939F877AEB9E3'), sunat_sol_password = UNHEX('C19F90DD72C521CC8A3040D19D1D446B3CFCCC16EBA232C45EC849CE5FE28338C963657896D0A9') WHERE ruc = '20605409491';
UPDATE empresa SET sunat_sol_usuario = UNHEX('6C31827AC9F3FC4B37F3637E1E7CAD6763013F002CD36E3B8396E86D68461FF670E56836'), sunat_sol_password = UNHEX('08371D24DAF404D49CEE55EFBCF90D7EDD3AF76AFD1B10E8D484B788A162ED08CF040771') WHERE ruc = '20611075791';
UPDATE empresa SET sunat_sol_usuario = UNHEX('FE8B610FC81DDA04E69B39259278A2C0B9CFAF2A01DD599BAF3751C0E058C2C9FC119ED4'), sunat_sol_password = UNHEX('BC4DE27DBCC5CF1CCF163E53C3527A4ED4C9BD3F7C72E9C5DF882A3F3E5642E4886A0461') WHERE ruc = '20525977901';
UPDATE empresa SET sunat_sol_usuario = UNHEX('ECEFDA3FE2825CE598FF053D93EBA4A508CBDE2446CAFE3B621F06A675521B7F3785113B'), sunat_sol_password = UNHEX('C1199DFD31E51E97204880CF00DB4D66A07D24E6813B5E2ACBF87E4AC39B1F7A7AB6132E1116') WHERE ruc = '20614891051';
UPDATE empresa SET sunat_sol_usuario = UNHEX('7084D8068FA2B8669C7D055DE4C7E7E471FCC9D9C8BBD0FC9C6D45905473934B3D662365'), sunat_sol_password = UNHEX('FC47865E7843F67913BD4AA547ACBA1B99F2175B9A95E9378AA068EFE28874CFB117B88419') WHERE ruc = '20614133121';
UPDATE empresa SET sunat_sol_usuario = UNHEX('BB496EAB8B0CFE4FC76F4E3C493371E33205951F903D9BBA4DC7228B3EE0FB3F027519E5'), sunat_sol_password = UNHEX('7053381CA57544BF018D1FEF038CFCE713E32CC68DA5FF8F25A3E17FD0156F590F95809C89D56FF4CD') WHERE ruc = '20602653081';
UPDATE empresa SET sunat_sol_usuario = UNHEX('CDD307D26E8BB5B318A9DA52692F5755F9CD800735636442F6E67F73F381F7D04DE82B2E'), sunat_sol_password = UNHEX('0CE0E04894A9283C01D86AD87DF4DBF68B977A7C5AF70ABE7552C64805AE5209A1680FF75A88FC9B80') WHERE ruc = '20614984521';
UPDATE empresa SET sunat_sol_usuario = UNHEX('2635CA5C97CAFCB6059233A2E2FBF3DE68CD22139AB86E2C2BAD383384D0227A8D282E50'), sunat_sol_password = UNHEX('16DEC5396ED0FD45AE8669D50B4F0F8A32D79698AD4D0DABC663CC41EFF60E5A87B8E7F35D63') WHERE ruc = '20615154661';
UPDATE empresa SET sunat_sol_usuario = UNHEX('109AE55F967B867A6595D0CD05880F4C4E2899C6FF2578C50652FEF2BE97338EDA35A193'), sunat_sol_password = UNHEX('A04F6AF477A1B50FD6BB65F6E248231B0EE4E8718006B6933D373EC776B0BBC36B13A015BF') WHERE ruc = '20608205251';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E16BA39D8425307B5EFD43221BDEA860E3D0A7555138725898B928E71C8AF3FF1AD3A4F9'), sunat_sol_password = UNHEX('66B2AEB3E4DA6B3A963CFC1D3DA463C2F156CC99E0A707D632A606CBA812254B3904F0C902') WHERE ruc = '20611141352';
UPDATE empresa SET sunat_sol_usuario = UNHEX('4AAC874116E5917229AC0717473A3282ED99E3C2D91E66C9D2BF78AEA60CF380A27826B4'), sunat_sol_password = UNHEX('95E64F1C35877CDAC01531CBC46FE31DDFC71B361127F2FB05C0B836F90C76FAD45F4B1E') WHERE ruc = '10778043012';
UPDATE empresa SET sunat_sol_usuario = UNHEX('D171304C7C985D59942A2490992EC68BA80A6D88F9DB70D0CF6E0927918115B79105202E'), sunat_sol_password = UNHEX('6E71ED8A33A429D6C03695242F2DF7038029E1CDE9394E0EDB08D5BFF66E95E1D0D6483A') WHERE ruc = '20609619482';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E67ED49F9A107F047B65F10FB25897155A0B5B55F7C4A2179D59678A29D65171E61C850B'), sunat_sol_password = UNHEX('9767566F447D59708C4BCC7C577AFBF44B4C0537D404A4EF4DA696A685FF8F30C165D87794BE6E') WHERE ruc = '10403433042';
UPDATE empresa SET sunat_sol_usuario = UNHEX('B3818264D5D6B805B8B1AE38A760C8B1410B859AF3FA8FCA869F52F6194959E1B5F21726'), sunat_sol_password = UNHEX('1FEF6C4092093459473DEC89659BD2F4BC6B46498387CDA9CE0A78B061E77EC5A808039318B60E') WHERE ruc = '20539814452';
UPDATE empresa SET sunat_sol_usuario = UNHEX('18FCF6D3EC741578F3CA2D7920CDACF655964A9A7A5FB83B24E6431B99BF17DA61FBEF58'), sunat_sol_password = UNHEX('714B4E8149B83F990496E6FE801562A553BADEAFF3BF81269E557F64CA774F04F9042AB82D3BC53F') WHERE ruc = '20607022942';
UPDATE empresa SET sunat_sol_usuario = UNHEX('7DB77FF36BE07D78D700F1351A610F4BC59BDD39C9656D97A6DBB1FC407D543E63BF8793'), sunat_sol_password = UNHEX('D322908FBF7F6A7DED50E5E3B9A30842690059AF363778B1C0F5369CAA06695CC1165EAE') WHERE ruc = '10448423552';
UPDATE empresa SET sunat_sol_usuario = UNHEX('5AFB6325D7EB6F153E332AD9EE0B30700528884374F867EE10996D783FBBF3492052BD4C'), sunat_sol_password = UNHEX('F4AD2F3CDDDE4761B2538ACDF764893F7CC47D3520C0082B6007280191BEF7D27F3CA0FF') WHERE ruc = '20611621362';
UPDATE empresa SET sunat_sol_usuario = UNHEX('73D5FFCA77FFFC77FB72DE8A502FD896EF881F088A01E7244ED5F498F36370B4EF984CC0'), sunat_sol_password = UNHEX('A4200BAE059638E029D6140F6B6E49604BBA80EA4E2242CFE45E4D8E411CA5DCE51690D991') WHERE ruc = '20604936382';
UPDATE empresa SET sunat_sol_usuario = UNHEX('5EE3A5766D43314A6EBFFF493EC9DE68B641E51AA0865563E6444614C3F08A867C21F61D'), sunat_sol_password = UNHEX('FA34FDB07C2499755C71D0EF29508BBBAAB5CBA0F2FB969C356A63A1B87D118FBE002CC1380F50C0D43BD071') WHERE ruc = '20613477552';
UPDATE empresa SET sunat_sol_usuario = UNHEX('AD1E667DF703B41BA7305B601B93D643A41C2A0DCA9EC9FF3482928907710A6F5D1DECDF'), sunat_sol_password = UNHEX('6063BCBE7BDEE8752EBC0169F609B086D8D6329D5777E79E3039B72498F777D0A44F9F21355E59') WHERE ruc = '20603685572';
UPDATE empresa SET sunat_sol_usuario = UNHEX('8599378744F8001C6EEAD5F17FB8FBD8B3298848EDE0B7603FD782D580D9930C573622'), sunat_sol_password = UNHEX('108ABC060F3888BFFADF2EFDBBED10CB23C456027D7E8B4E3EA70D0558C14E6561DFD686') WHERE ruc = '20608181092';
UPDATE empresa SET sunat_sol_usuario = UNHEX('25E19FDD439D9B3E20580C47803CC5BDCDCCA2E3917DEA3320F7289DC684F36392B8BAD9'), sunat_sol_password = UNHEX('258EC4579F6ABCEA785E2BACC85D965D97284DB5F869BEDAF154AFDABDAC766D1D840753C696FB') WHERE ruc = '20482740562';
UPDATE empresa SET sunat_sol_usuario = UNHEX('45AAC9AB2A07D67FB44EB11FB4A1EDEA8D8EA3AA475137ECA0BD33D5A7DDD025B36DA2AF'), sunat_sol_password = UNHEX('4C38B9B2772059AC0A84EB8D5CE0804EFFD6A4D8CAF9EE70CFA9BE69BA105961C09E9CFCCE1B9C') WHERE ruc = '20607548782';
UPDATE empresa SET sunat_sol_usuario = UNHEX('3FD9CC07E45F889D9C277710D7E3AD525F5ED0A9E2A84BBB2E9C2C9F27CAE340809B2A24'), sunat_sol_password = UNHEX('47CF7DE46C5F7F0676B7F92F06E8987AED427E51737A3D66A435FA333547FDBE26C2D353C419CD') WHERE ruc = '20440337393';
UPDATE empresa SET sunat_sol_usuario = UNHEX('9BC5C015F31C73C343BEDDAFC6A36DCA28B7ACA87413876346A8D82233993A21B91A7B2D'), sunat_sol_password = UNHEX('E16B2B9896B5CBB74D7A6F1B6D7B81918F269EEDEE66097A2041078331078A2D6F51E10D17') WHERE ruc = '20604626553';
UPDATE empresa SET sunat_sol_usuario = UNHEX('BF02BCDBFAFF7BB14ED381E0F8523FCD542458936B82031156B67E1D5ABFA3F38368591C'), sunat_sol_password = UNHEX('C44157B6CB5BE2EEBD915BEAC0091D98C4D28F93BB3BB20F28D355FBB331A53D016DBB6EC7') WHERE ruc = '20600497473';
UPDATE empresa SET sunat_sol_usuario = UNHEX('C2F4303BD80AB4D2B93BB5896D410C0E8E6D4283F250695FAC586BFD411717F34C7625A3'), sunat_sol_password = UNHEX('94B56C5517FC21822B85B4CBF5BBF0965D433119DFD4F243C952C24B9E1ADEA2F65CD865') WHERE ruc = '20559806243';
UPDATE empresa SET sunat_sol_usuario = UNHEX('91122B550BA617BB730DAE292FC2EFAEFDF4ED67C92F8F4FC2C43DFA927E30AE50E2A7A2'), sunat_sol_password = UNHEX('73C6E28BB572D26E0F222A99E2F659037D8BB20C181DADA8862CC8E423CC6896E71C0292') WHERE ruc = '20602587763';
UPDATE empresa SET sunat_sol_usuario = UNHEX('4AD9167AF529271B9EF1B06B399EDE93B35024566424B2CAECB5A61045FB46367D4CC61F'), sunat_sol_password = UNHEX('E05614AE6D77FFEEC21982AEE4C1D823AF480275A593DE1C2A2975B045FEB78F7D04FE442F06377421DB') WHERE ruc = '20430177053';
UPDATE empresa SET sunat_sol_usuario = UNHEX('F237AD708786C2443D4E740106232ABB64FA007F72431B85953C0503C71822229D9CE433'), sunat_sol_password = UNHEX('695A146F85755AF2BE617A8C1C864B77164BECA043B76F5679F8C322BD0FDAEA3F92214A46') WHERE ruc = '20554950923';
UPDATE empresa SET sunat_sol_usuario = UNHEX('6FF8C32603DE07DDCE71F6D1ADB1755D7360F69185C0F8AD5956549F8F8A04AA8E1F3021'), sunat_sol_password = UNHEX('D83D78871907EA364105E445ED347DFDA8F00D19B81ACCE1F3F41C1439A40797B5E1D1') WHERE ruc = '20607922463';
UPDATE empresa SET sunat_sol_usuario = UNHEX('9A9ED9166475C6921C33156566F7729DBB7A2DB88BC080A5FFC278D4405C267CED57CF12'), sunat_sol_password = UNHEX('6F39B442135313A556025D6CE376F786A40D3474787BEE077FDF5F52365484DE40DFD372C586F9') WHERE ruc = '20560131993';
UPDATE empresa SET sunat_sol_usuario = UNHEX('6C364A929EFF349824D0467C4A80674076724A295171F17982B9BCB69F142F13EA11BE9A'), sunat_sol_password = UNHEX('E0A43D71425B9051081308AA18A93E7575A55AC41545A090287B2B30101A9DD79EB11067478B0A65E8') WHERE ruc = '20610364153';
UPDATE empresa SET sunat_sol_usuario = UNHEX('9209E8A5D06F421ACCA9DBF393FC0D901F169A0C3BCB74A115519D58448FDA502A2DE0A1'), sunat_sol_password = UNHEX('BE910E43FA869F06ACCD03518D08B592A1F4A8E2E4F23C3ACC527931D658373A446966342908') WHERE ruc = '20613460633';
UPDATE empresa SET sunat_sol_usuario = UNHEX('0FDE948860AA663B022630652DCD5FB3D15A08125510414E4C9366A00C4C8F789BF79C33'), sunat_sol_password = UNHEX('C619C7F95463399716E1E30D0C2FDDFC0B5D10E420DC9810A4F364114D717C9ED28FFF5E67F092') WHERE ruc = '20481328633';
UPDATE empresa SET sunat_sol_usuario = UNHEX('DB91E92D94033218C227B4FC2E1751ED763AB14216E87612838E2937ECF622AB7FF02F1C'), sunat_sol_password = UNHEX('94336D674957B5E786712CE89E70FF7BDBA47ADF0796956525AFB100C817967020C7E98DBCDCBE') WHERE ruc = '20608376373';
UPDATE empresa SET sunat_sol_usuario = UNHEX('7F97F5BC05B6CB621E73909588DCBBD507579CF2D8DCBADD571DA4ACCEF25EF453DC0ACE'), sunat_sol_password = UNHEX('102663884A2C15B84B43C8C72951267F56DE63AEAB989C3C817D1026D053CC4DC36B36') WHERE ruc = '20603237693';
UPDATE empresa SET sunat_sol_usuario = UNHEX('1DA4F021A1D5B205C91AAFCE6BFBDC2DF46528AFDE2AE434E78FC17BF4966D7D61F2F8EB'), sunat_sol_password = UNHEX('D8A9FB2410E188B248F41A4E757604F7EEB2BD79F17EBFD21A1801D43417AE899B918FD535') WHERE ruc = '20440073043';
UPDATE empresa SET sunat_sol_usuario = UNHEX('D2137AFA89C86E40050A11756EAD9EE3838B37E7D80159D46C7B62A3B1E6DE3F426F5152'), sunat_sol_password = UNHEX('A917273DEEEF0A9F7DE35736E40181F5500C4F968830B5263100D5A4F3C85DDD3BCF0321A4') WHERE ruc = '20614199963';
UPDATE empresa SET sunat_sol_usuario = UNHEX('280160F3245A5635ED70EF50D75625D7A07CEA48D0EAB1E9A9B1955BB619FC79B1A1D257'), sunat_sol_password = UNHEX('36731B6B5AAE458D98FA9FCCDB98DA82ED78F175653BEF3F07E0C3E064C0EB8EF95B68C3F76A') WHERE ruc = '15511824483';
UPDATE empresa SET sunat_sol_usuario = UNHEX('041C6EC9113EB9513F614CF626ED15A705825813DABFCC3D358A66FAF8CD35DE94ECFA6C'), sunat_sol_password = UNHEX('4B55D4DDEAB5E02336E2F08200D5A51035C01DFD542D2F5A795C5BB39CF6DE0D78D9F22EAF') WHERE ruc = '20482552723';
UPDATE empresa SET sunat_sol_usuario = UNHEX('36FAC2D075F82854DEE75C6AAD9381A4251BC56078A211D3EF7AE21E10155922D5574D7F'), sunat_sol_password = UNHEX('ECB7B25FDCDD4083BF15B7A5D005D6223E0EBB3A0B888B6991CAB1EF281B861B03EFDB') WHERE ruc = '10279661864';
UPDATE empresa SET sunat_sol_usuario = UNHEX('012743A494BF5439231A57CD57ADFA7BF1CC2C3051EA014CE9FAD4C65DA9284778FBC060'), sunat_sol_password = UNHEX('642FBC6C0813AFEABC15CA23480B671EFC7885378158BE2517891E4A04776973D074863DF6DB42') WHERE ruc = '20607414794';
UPDATE empresa SET sunat_sol_usuario = UNHEX('B967C0FE80217AF0BDFA4D85D6D90C3DEF2214B7101E9C99C0EC9C3A93C9A6338CB75510'), sunat_sol_password = UNHEX('05D3D1C70B3C27D541B6E2EFDE19A71ABA8D8E287A152784AC39FAA81DA6E689D5F73B') WHERE ruc = '20606791004';
UPDATE empresa SET sunat_sol_usuario = UNHEX('CAA0168A3BF016A641DCF03D2572C29D00C152189A98932CEDFEDE28572F06A843BBC184'), sunat_sol_password = UNHEX('E6DF38445E582C1C2D9C23316C317853C3C23A3DB7FEDDD901D09E1667017C6E5207259614B7DC') WHERE ruc = '20605721894';
UPDATE empresa SET sunat_sol_usuario = UNHEX('8596A343DF3EF2C3E48F62D0FEF512A68A3DFE6A4D0D451539FAFDE241B43940BDB679C9'), sunat_sol_password = UNHEX('36ECDE61BA268960000DD367FEC9521FBF43DB569E8AB08CC74EF254772A1D5EDCD3271A423AF7') WHERE ruc = '20606106484';
UPDATE empresa SET sunat_sol_usuario = UNHEX('222853F17F57CC218C411E7DFC5949162A957F299CAA5B3F0BA4B7D208EED5A85BE55539'), sunat_sol_password = UNHEX('726CFC3350DF1B83A65CCC64552BA45C31AFDD21374DD85F7CECF1B3F264641B62FA175D45') WHERE ruc = '20613014404';
UPDATE empresa SET sunat_sol_usuario = UNHEX('88129810F58526C996E9947EA70C60870441C7D6B82484EB3BC4D50CA15D351B915C75F1'), sunat_sol_password = UNHEX('8E514543FEBAABB4386F458FA37C720E23DA2B1D4A0A8D00B06F93E6529DAAE1CE1418D197') WHERE ruc = '20614319594';
UPDATE empresa SET sunat_sol_usuario = UNHEX('78D9C9CBBAF9E850C649E9FC2503A4AF65A8BA373888866C62AB6CB3A109C2877D102A4E'), sunat_sol_password = UNHEX('38D91D91C7B2E6C0640D94A54FBB1BDF2A51A2ACCC0F675FEABAC70F2A392786CC4BE347C776') WHERE ruc = '10716380594';
UPDATE empresa SET sunat_sol_usuario = UNHEX('D6D017AA08EB7BD9DC389C930D2D377DFC1A59DC1D103972CBF38B639859D0DA51F35AF5'), sunat_sol_password = UNHEX('7D5683EA28E93EAF3188A7F9812A10AA36570B31C1A6A156359D6DA0E5BC701D3D261B9293') WHERE ruc = '20612147664';
UPDATE empresa SET sunat_sol_usuario = UNHEX('9FA04BFBFEB9E792DDAEBE837473D37286E7C22FD286C73B3789B42CBCE92565CBC49960'), sunat_sol_password = UNHEX('C6992ADD4F1C97385C47AD8F5D5F5BC90782C629CC4D26DE2B713E301430BE7EE5BAEA1364842F82') WHERE ruc = '10413313355';
UPDATE empresa SET sunat_sol_usuario = UNHEX('F67628272B20625F5674C6E2CE471D03D00E232963632CB1A7B6C2F58765416615AB56E4'), sunat_sol_password = UNHEX('4254C1B8FA184FE8920229003A89D22A97AFDE5CEDC506F74F32822EDDCB88CC130C4CFB45') WHERE ruc = '10438095565';
UPDATE empresa SET sunat_sol_usuario = UNHEX('14B166FD7ED59D002EEDCBE172144D9C5203794887D6521BA7AE5F2AF73A830F28E5F072'), sunat_sol_password = UNHEX('1887EB7239081F8CE381D388ED49112C750D4693721D8F85D0D0A255C20085B6A70980A6') WHERE ruc = '20544929365';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E8D31C4B5D9EAE7594E0636C076522045ED07AACEEDE0B4D29F097EAE2F46019D16A648C'), sunat_sol_password = UNHEX('1EE08E1F976ECC540F26EC4E04ECD58263A4471E8674C910E266105792CF53029464E7D17E5D8176') WHERE ruc = '10416201175';
UPDATE empresa SET sunat_sol_usuario = UNHEX('6AA7A3B4092B261193669CD8417FDB220BB72601058ED7C12F2694FFF53AC6A27DCA42C4'), sunat_sol_password = UNHEX('6B2A87E93514EF8DBF6216C81A8469368BD39E05E1C85C8D33AB90135A215994401654013978A6F0') WHERE ruc = '20605212965';
UPDATE empresa SET sunat_sol_usuario = UNHEX('BA4067FBABABD1E4D69F53441E2DE228C1EE967E98A3E6098DFA392A3529B2B2DC3B8AD9'), sunat_sol_password = UNHEX('859E5D793F1A3D68067886928854DE758FF2E9EDF581A512C5E8B2CE7A9044EA3A08348163AE3AFBA1') WHERE ruc = '20605365435';
UPDATE empresa SET sunat_sol_usuario = UNHEX('F182DDA36238C383A2A8626CC392DD41E88B8C820066DEE4290196879DB334F14FB5FE2F'), sunat_sol_password = UNHEX('B5B3161BB019F3B5138B8BBAA8A823EC4599C4FF99C42BAAA0628397B8ACCCEB43E7DF891FDFFF5340') WHERE ruc = '20613736825';
UPDATE empresa SET sunat_sol_usuario = UNHEX('2411AFDA0CC9D1000BB7B7D38C3FA545E3A400C7F8A76C132C53A93D7EFE715FB4F324D7'), sunat_sol_password = UNHEX('AD790E068B60D0CC4075307E9B71AA0D491E0DE5677986ED09B0A76DCAB6FFA40935FC85B6') WHERE ruc = '20612375705';
UPDATE empresa SET sunat_sol_usuario = UNHEX('CA6726E1AB8A72E6BF455996756563E3EEAA6EA4C270172DBD8540CE432D2DF994DCA746'), sunat_sol_password = UNHEX('748981EEE796F15B8BC6833920542D000E61AEA8D382EAA06BDFB9A664A82B9C7F8B7F69CC1A') WHERE ruc = '20606791705';
UPDATE empresa SET sunat_sol_usuario = UNHEX('292CB35B6ABD2207639CD7CAF5F76B8D349F3C566012FEFDB26650071360B8B7118A10F4'), sunat_sol_password = UNHEX('F44A7A0848D494100D0DD4D2B518E4945E438749F95EF45D21252EC71FA2D4F3BE6BBE246CEA') WHERE ruc = '20603784945';
UPDATE empresa SET sunat_sol_usuario = UNHEX('2FD39E4299A3DA1E05875B3CE67324A2A4E24C96746894A3B4578D219C2302C876AB25AA'), sunat_sol_password = UNHEX('D297988E4B3A43772DFD83405B4425C45E52E420C5296F10AB10CAABCF6328CD35A57B16F5BC6A') WHERE ruc = '20614322625';
UPDATE empresa SET sunat_sol_usuario = UNHEX('42D04E9A91566FD3DDE3071981C986D1F4783C894C9C7F65B29865D0A5D2DEF7BF9F1F33'), sunat_sol_password = UNHEX('9806CA8249979EB03752ED9A5126C8D1F90D62A5466EE30B0C4160C7E9F89798A5F72422FB') WHERE ruc = '20600713125';
UPDATE empresa SET sunat_sol_usuario = UNHEX('DD017B0DE325717A4322E82AB47DDD4721F8E450F2961D9B09294288428D91193F67922F'), sunat_sol_password = UNHEX('3AA75EC90C4D936BE47148DAAEF46EA569BB963B34031B5CE219E14022DD4949F34FFE9DFA5198CF') WHERE ruc = '20610633995';
UPDATE empresa SET sunat_sol_usuario = UNHEX('ADDCACF29999221C97A2F563503F5E9CC684E0FB05BA6F2366322189B77BFD4328DE4EE1'), sunat_sol_password = UNHEX('7D8D94BB3B935BAB94BF85686737CAC8C06B2830BF819706B0430720EA60F2D3238391') WHERE ruc = '20481610495';
UPDATE empresa SET sunat_sol_usuario = UNHEX('5A359FDA5266330C6B3B23846BEFDD30721351A7E52BECE61820D5D95D5C23A53E3487D8'), sunat_sol_password = UNHEX('A5D4B43431652FE744E930856D5AB71A4852BBD4979A323D357049C071D04AB55CB1A57E79') WHERE ruc = '20614280205';
UPDATE empresa SET sunat_sol_usuario = UNHEX('3D09D9C835855E3C5B54AA291EB6B2ACD7F4734D6F37027E6F327AE1D915D13810F77555'), sunat_sol_password = UNHEX('26BDE2DB6BB18885AC47A0401CF568AB7A1EC44DC81FB5A33EFCA6D6DF3BE08722B046E07855BFAF') WHERE ruc = '15615507285';
UPDATE empresa SET sunat_sol_usuario = UNHEX('4E1C48DD29DCD13C94F3B2C0E1EFA8F48B1F65BCFF27AD572260AA5DF9989983BC726663'), sunat_sol_password = UNHEX('2BFEF87C73FCA92187BFA2752772E6AF5D40DBA1D009511843279F9300B69830385DA55773') WHERE ruc = '20604222096';
UPDATE empresa SET sunat_sol_usuario = UNHEX('75152C1E7E69E79453772F1662D5D808573DAF5DDDC24B3837DF736DFB70538A3B79B256'), sunat_sol_password = UNHEX('EFD2A5C2A94009B7C94D9EA70BD7950527DA0B8A281B6563CD0EDB8EB6AEA642FB63FC6A7B') WHERE ruc = '10405015396';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E70EBA17914B3BF8D6D54CAE5950505BB988B03788A8E6BCDF5B07B8D8D8F052518A088F'), sunat_sol_password = UNHEX('63BA562E2DD352D6C82D708BFD38346560FE41E4534DB92DA2DE035D8FCCA6E6FC7CA216DDEFE5') WHERE ruc = '20612420786';
UPDATE empresa SET sunat_sol_usuario = UNHEX('936DB9867FFC5ABF5F1834F9B98F4DF34919416E449F9C625882A0A94A32252463374D17'), sunat_sol_password = UNHEX('99074BB440CD2CF90DA0B1AE0178821890018B68D5B2C470CB7F3957EEC2BDAB07B892') WHERE ruc = '20607693316';
UPDATE empresa SET sunat_sol_usuario = UNHEX('D966CF5C1F3499E298CC48D46058120871BB7318E89A485F99EDBFC7D0511A95E3BAA265'), sunat_sol_password = UNHEX('2B92F1BE6FEB9BA6060DA70378407954E28EE72C6FC70CB0246D08C5B03DA2397D459067F6') WHERE ruc = '20606779586';
UPDATE empresa SET sunat_sol_usuario = UNHEX('684DD71355C27A76A1182B4D1278097F19271F64399F7714939409582A868AA4BAC25F27'), sunat_sol_password = UNHEX('95696BEED4D50E5E2E94209B2C5D15D8F4D68AED6A78C339D1B8F4F37B7BC937C11C64A3AD5778') WHERE ruc = '20559673936';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E56594C5E30A195218ADDA3B9B5B65C6F188561F00EEDAAEF5834C6DF2979CA529B3880B'), sunat_sol_password = UNHEX('A00702A31399E558D5E583D51204656DBEECEABE616A31D362B3D56412B3FECC72BAB9B8436EC8') WHERE ruc = '20604708576';
UPDATE empresa SET sunat_sol_usuario = UNHEX('F5042466D56B2C564B36E3A887D56BA35601330FE49EEDD858B2E4890B007137F69CF774'), sunat_sol_password = UNHEX('323A5DD6ADF808718F569B2AC65A3BA6F9EE5B96608A843104C24278BAAECCF64DF4AA11') WHERE ruc = '10195646886';
UPDATE empresa SET sunat_sol_usuario = UNHEX('BF8770D67FC25F06E27241B03D31BB7841AA7D5D5D719EDD329746EB655192CDB69B01EF'), sunat_sol_password = UNHEX('414C1F7580DD13F3002FE5AE19115B17B1DC091BCA953F22F73A6072A5D72F4616DE2274D3') WHERE ruc = '10752265386';
UPDATE empresa SET sunat_sol_usuario = UNHEX('D4BD57AB7309219FB3BD1D74104EF79BFC095EB2C16E25ABBF6784F12263D8613141D650'), sunat_sol_password = UNHEX('690544303D9BBB0A15CBDC67CE0266162434361C7DBF2D98810D6A75DE54D6FCA3A26C9D5AF0') WHERE ruc = '20557207466';
UPDATE empresa SET sunat_sol_usuario = UNHEX('DC014DD04C4BB93B4E64A07DED87DB047A681C7C9FBB42B86E5D50B9ACB26BEC7C4C030D'), sunat_sol_password = UNHEX('1976B1F94CD36C740B229A2E75583341D49BC8B641B758D312711934859886F9E732AAC5FCCF') WHERE ruc = '20439924226';
UPDATE empresa SET sunat_sol_usuario = UNHEX('39EC07D26D92F1FD07CC2C4C1CA1DA748B13ED7CE9366881281DE320C16E12936E282170'), sunat_sol_password = UNHEX('5ED8486CD5066D1508C9FE1AF15F9761081A0571CAC6651E6E19E420B9E8F302FB021B4596') WHERE ruc = '20614852756';
UPDATE empresa SET sunat_sol_usuario = UNHEX('A0010A5D4901CBB2C22D84B8E9C0A84714E8999C7E561F5C9C557C14E2389B86A9556A91'), sunat_sol_password = UNHEX('295F93B65F2DA94E5FDA20572C92EB0BB5B6E4CA877A52DD9E517374DE34725B07EBC9381FAC40DA') WHERE ruc = '20482685286';
UPDATE empresa SET sunat_sol_usuario = UNHEX('CC735EA7D2DCFDB888CBBF9992FCF8851C44655ABB48E66586B0E75489AE4456CC40F338'), sunat_sol_password = UNHEX('FBFE9E25210D16A19D3BDC45E3097F39D23BD61DC411F0125A2D71C6B80D622768CC8EA921D17D8FE61C') WHERE ruc = '20482257217';
UPDATE empresa SET sunat_sol_usuario = UNHEX('D51A13E7A4B4CC3DC013EEAD004945FA074F0933D53D9CD5DBEA6FE6177213BB4F634717'), sunat_sol_password = UNHEX('4A6E88599D203E7958656CCD89F0D1B20D9A81B2A92AAB657C0B56E3F156476C45FDEECEB5D3') WHERE ruc = '20481823057';
UPDATE empresa SET sunat_sol_usuario = UNHEX('7ADB9EF304A1D696DFEB2FC4FB679273DCFCFC2A7424E46E7B4D9D1ADA0E2365B9925451'), sunat_sol_password = UNHEX('A15CFD1CD3C35319AC66F5704C6CB1D1E68FF75ED3C68D5453DC12A6A3341E380EBF26851E37C73F80') WHERE ruc = '20539949897';
UPDATE empresa SET sunat_sol_usuario = UNHEX('44A50F03EF1B95A7FD7F1B1E8183730A59556D502BA5E5775368278DCD1047FF8D5BBD56'), sunat_sol_password = UNHEX('8FCEF172046FA6FCF8B2B01A52B0BC580D108F8D3AA8C15C6D89AEA8604AF48B8A3A4CE1549C3F') WHERE ruc = '20603146817';
UPDATE empresa SET sunat_sol_usuario = UNHEX('EB66ADFB10A31DEF446D352294438034DB892689FB6A33DDFCB50DDEE30DA00F8C009D9E'), sunat_sol_password = UNHEX('60B83860BA9A42E224903978EA1324A675F9BF21B99BC49F74EF13F886AF7B859440745667AC') WHERE ruc = '20605580557';
UPDATE empresa SET sunat_sol_usuario = UNHEX('4127567FDE3E6F61364BBF39A445DF8FB37B5B71386A796CDB2079D13BAE2954F9F4DDBA'), sunat_sol_password = UNHEX('7F9BAF1D61705780E4C724CB02AC3D5E154A72E18298F2137CC2BBE6DBAB5F30CD95674C971480') WHERE ruc = '20604613257';
UPDATE empresa SET sunat_sol_usuario = UNHEX('B85191D46F40DE79405AF3850325850AA59982D0C132587BA73AEF9F95752AA4A0283E03'), sunat_sol_password = UNHEX('BEDEF072A0CB84328EF0ED6F2F036392206650EBE5A7E5C32919778AB23D3AFC532D4E') WHERE ruc = '10179286837';
UPDATE empresa SET sunat_sol_usuario = UNHEX('A9E76DB737A3D385954D1E9D1041950FABB853741FFA3B5EED106C433A195B996BB1B2D6'), sunat_sol_password = UNHEX('2173B444637C4D9912E5EBB2BC122C763A5FA979C5370B6AD68E2263A04052F7EC62DEB7') WHERE ruc = '20609724057';
UPDATE empresa SET sunat_sol_usuario = UNHEX('3071B6FD008FA970CBEC0DE49CB54EC7F517AB5093168B165E8A31C84B7355E638B73CB0'), sunat_sol_password = UNHEX('ACB7EF91FA9240759650253D75EB6CAC0F7699EC3235C58F7EC5D1F7737012EA1BD02B8904A1CE174A97') WHERE ruc = '10452341617';
UPDATE empresa SET sunat_sol_usuario = UNHEX('2441F960E9E14F103170B560397CA12F92DD3051778BAC319A02713A061D21B35447EF'), sunat_sol_password = UNHEX('DC5FA45F901B8A77B37CAF74919391F888B1831C1665D48C93243550F359309A4A78D2019D') WHERE ruc = '20608146637';
UPDATE empresa SET sunat_sol_usuario = UNHEX('45B5C80755F08879C36ED4AB0F96FE502C139F42F6FAAE0B09324CCF8AB3AA9472642C5A'), sunat_sol_password = UNHEX('A5E29A54D9610CFC4751952543438F1E6DCE72CBF14A98FC69ED6A0CDB2D76E0DB9724') WHERE ruc = '20480868537';
UPDATE empresa SET sunat_sol_usuario = UNHEX('CF90F43E735EDB3DE3399FC08B79907D13DD9CA008CC39AB4299D5C7ECDDE95EF0395BC2'), sunat_sol_password = UNHEX('3DA6001E53671C282AA61DE4C23A78A77FE383E5AEFDA4798601F9B533C0C4215B0DC51AE2') WHERE ruc = '20610946837';
UPDATE empresa SET sunat_sol_usuario = UNHEX('50375F0FC57BF321677CB10BDD4BA50C3808092C8A8ED125ED834C52DC3AC4C6DFDF7E45'), sunat_sol_password = UNHEX('9D19A57A1B9D0625526C2724FD245357A1D4AE6F7410EB715B54A482DEE00DC21A6CBB781EB9') WHERE ruc = '20609158477';
UPDATE empresa SET sunat_sol_usuario = UNHEX('F0A7B04045EF5B31A3DBDA4B130EEDD912A76E672AD5282733149F9C3600065248306589'), sunat_sol_password = UNHEX('73AB111F100245FA64CEC79DC294894187A087BA215A9DBDCADB391797E34377F2D77C2EC963B5') WHERE ruc = '20605245707';
UPDATE empresa SET sunat_sol_usuario = UNHEX('88081F0A51C21621F2DFDC868F457EEAE46C835459644BEDE775D42DE624406DDC114D12'), sunat_sol_password = UNHEX('73B68878651E3FBC111B01DEE4896EA699C23B6C1646A2EFA4BEED8EB4FB77F65ED0B769E8') WHERE ruc = '20612778117';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E1A78CCA9B216B2F58D73ED9D09AD250E57ADAC4C8D75DAD086C21BB9860620928377E15'), sunat_sol_password = UNHEX('C0C6B754FDAE2304B606C02B2DF0F97BE29B90F6FDC8790323FDBC592D8EE695B6188F98') WHERE ruc = '20613718517';
UPDATE empresa SET sunat_sol_usuario = UNHEX('B7B9446C7ECC519F07810E56F30CE26BC509CD8F1DF5D8090E4C26A084D92E04ADAE5361'), sunat_sol_password = UNHEX('694195ED2FB3280434BA6E1C75AE2FF30D5A6CF7A40EE81FC7FBA49983C0CF0493112161') WHERE ruc = '10457501507';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E696BB19A02E509CC4191CAD39A24C58328D1E2A75C87871151A98BCB1D6E09B746F4AC2'), sunat_sol_password = UNHEX('8614DBC4EF595FFD1D38DC071FF6E1D67E31A27DA1FAA55B95AD9E973663371007D874DDBEB5') WHERE ruc = '10429855247';
UPDATE empresa SET sunat_sol_usuario = UNHEX('FA5116D235A9EFC7ED8BF91167CA019E83333BF4164F74758BFD2BA7E5292B4B3F687042'), sunat_sol_password = UNHEX('52094F33789CC6EB967B15A5B81D941EA10CF1A07E2713C1D00DF425899B0F3CE3E20A29') WHERE ruc = '10421615387';
UPDATE empresa SET sunat_sol_usuario = UNHEX('A421C123A403B4AF47C1A7EDD61F619F82A564F5EEBBEDB1F61556838D0D0C8AED4916B5'), sunat_sol_password = UNHEX('EE17DA21DF23D3BE4F778DBC415B1E33F5FE769BBDEDC88B3CB2625FB65A260054EF9B6FE8588F') WHERE ruc = '20526265107';
UPDATE empresa SET sunat_sol_usuario = UNHEX('DCF4E5AF6333041F217AB79024F873649BDBBDE3EA0E0B13A6D2C7B4A3EF19EF82D7A1AD'), sunat_sol_password = UNHEX('FA0F5278B00DDB1BE871B62E302FFFDB78CB3666E54629CDDE222E9401215BA8D1215C9B74') WHERE ruc = '20477398457';
UPDATE empresa SET sunat_sol_usuario = UNHEX('8E07CFBB7B9FE502CD784373D73350787D85CF9F3194FB39948AE023D83DC3CB37001F2D'), sunat_sol_password = UNHEX('7D5C2116C45F07760167C95BE451123EEA27D382B73E3002D78C16967626B6626BCFA0185C') WHERE ruc = '20615067998';
UPDATE empresa SET sunat_sol_usuario = UNHEX('59E9AF7F7C06B6333A29BF217BF64DAD0941D71E649FD17528B05C1AD9C29F374C10529E'), sunat_sol_password = UNHEX('BC12D58B201536F71BB26C9E77C84B9A78CE30ACE0D74F1476BF5F9ADCB560047E4D2153B1') WHERE ruc = '20613228218';
UPDATE empresa SET sunat_sol_usuario = UNHEX('799A830237FF0928BF52D3851511E60B5DF67826BB5390124E5EDA2254A05D5345DF01DE'), sunat_sol_password = UNHEX('F66B136DD917DFAEE2CC2A586471913B5FAA5E0F9A0C49B26F33633085B14F652996052D36') WHERE ruc = '20608427768';
UPDATE empresa SET sunat_sol_usuario = UNHEX('229867023894B2A4BD408DACA5B2EAF15EB3E29EC82BE3DB648F7F4C24CBD1068DB2DB0D'), sunat_sol_password = UNHEX('0832CDBACD9252208F7E5E16D5DA359471BEAD341E94B654D7C5AA3FDEE42720A686C6FBE1') WHERE ruc = '20612633038';
UPDATE empresa SET sunat_sol_usuario = UNHEX('864C1FCC87A76434E91E6336CA4BADA415AFF700CBE188DC0A225105BC725CDFC2221DA7'), sunat_sol_password = UNHEX('6877D63D322D86AFF9FBDB141FB272DD7837A4BD0CE691062D9406C981F52F34D14EA00BB5') WHERE ruc = '15102960138';
UPDATE empresa SET sunat_sol_usuario = UNHEX('F0E1C970171E01D5E75DE021FDBC9D67176C9DF12D73734AC131D779558744A1F1E1E564'), sunat_sol_password = UNHEX('6D72B4D3FEDC99DE7A4029DC473AD049A506AD1E10A5AF8CA45B0A816B2936D4BF515C1F') WHERE ruc = '20604565708';
UPDATE empresa SET sunat_sol_usuario = UNHEX('B10C1AFFC072AA620ABF6AE1086824BA797D9A00C79B2658791CC852F541DC73913E6965'), sunat_sol_password = UNHEX('E22DB627C29B2C2CD5EF3489D2004C05EA115EED07C660EA8538C871FE0352372AE8C05C39') WHERE ruc = '20613942468';
UPDATE empresa SET sunat_sol_usuario = UNHEX('6104E7A75B95E778410FFC8CF1942DE0B1A664F4B781E91289602DA399344870FF2CB0'), sunat_sol_password = UNHEX('01C28CA326FF0BCCC2FD2912CB7883D3E559F5B0C5A31C791EDA8255D60570B32F4241E9') WHERE ruc = '20611845368';
UPDATE empresa SET sunat_sol_usuario = UNHEX('B2F569FF180441C1736C920B59DFF1A6DE8557CF6580139D8C4303EC24CE68A3637EA0C5'), sunat_sol_password = UNHEX('7951D4973CC2A95EF6F7196FD3F5B5324F57860EDBF4D408A26FC981E6637412136CC7A5C27106C4') WHERE ruc = '20603781628';
UPDATE empresa SET sunat_sol_usuario = UNHEX('C349984C6C81640A30D6CD48EF6604F44143503E030EC309E5A9CD21F20919AE6372FE9F'), sunat_sol_password = UNHEX('D94AF4AD08464B150F0C016C8D9BEC75919F88EFDDF9B3D1280A31FE03EC9EC8E61650C319') WHERE ruc = '20612499838';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E64792F5D2C497D640FA6B355F4A9C6FF3E9BA96199EAE0EE331C3373468E2E438C75FE8'), sunat_sol_password = UNHEX('45855F7935C319564348A4268384C2C5A78FD4D358368A176E121861FBD1E2E5C31EB0E54781') WHERE ruc = '20611154128';
UPDATE empresa SET sunat_sol_usuario = UNHEX('C387AF88E8CDF39ED8FA6333A34027EC558D9FF34C1F80F5569819820E5C469D7FD3C2F2'), sunat_sol_password = UNHEX('1A9149BE0D8C8E3E69A10A43894192A2FDE347F5968C74FB135C98F0F02B5823CC1851CBD7') WHERE ruc = '20610468048';
UPDATE empresa SET sunat_sol_usuario = UNHEX('02F65554C30F123313C2EE9B65083BE08867D348A01A2977B66EC9414A35BF3CBE2158B3'), sunat_sol_password = UNHEX('4E87F5DEBE182C1A5BE4D70BEB13881AA20756445F45B4DFEB8E9577E30E255D7303C2458F') WHERE ruc = '10413221558';
UPDATE empresa SET sunat_sol_usuario = UNHEX('979752755DA2F78461092B2D3C2A2C66FF29E15C3EDDC0E45F19CCA866063CF304B6C63D'), sunat_sol_password = UNHEX('BEA372C602014E69391E5A5F15B1C3896A692F37CF3F227523F56F41AEA1E7795E428DF6FA57') WHERE ruc = '20604393958';
UPDATE empresa SET sunat_sol_usuario = UNHEX('968477B866F684B32CD3925CFA08606CCFF43943C6631B96589DFCF9E7F4093097AE60'), sunat_sol_password = UNHEX('B4FA913747EFC0430F338FE3B811F99EADB93A43FC98A482486F053CDA8BD0449534F1C2D73C8E57') WHERE ruc = '20612328138';
UPDATE empresa SET sunat_sol_usuario = UNHEX('64F3CCDC9DBDEF47DE13C10B1C76A6F824AE557E95C1E0FD1EB55710AD723D4EB9C99F4D'), sunat_sol_password = UNHEX('56BE0CEA283E6D690C7E36FC0D2B75301B137D43D1E818D287F142F027AE53CE0F7D4043FA') WHERE ruc = '10478992128';
UPDATE empresa SET sunat_sol_usuario = UNHEX('4E6D38C87F00ED239D378282132FEA10CE1E93B41ADC1B8FFBD009F51683D7C93DBFE99F'), sunat_sol_password = UNHEX('22DC13973F0A88ACB1CDAFA04A597D1349592F89D12D851B5474EAB3E9996D4E06E906EA64D8D5') WHERE ruc = '20611680458';
UPDATE empresa SET sunat_sol_usuario = UNHEX('3F6831B312E37673E8F5535F16CE2F68BEDFE9367C49DCC6396CF5BD751C59EB22F7A8F1'), sunat_sol_password = UNHEX('38888F080CDB542C85583BA964FAC87E4CF044204BDA6175CA223AAE87F124D3A110') WHERE ruc = '20609337568';
UPDATE empresa SET sunat_sol_usuario = UNHEX('D94B463DFFCAE419947A4A5649BA18351F111BB44DC90A6E53F74283AE9C418DB884102F'), sunat_sol_password = UNHEX('CFDAED44C9563B99D1922061EC4A1A3AEBA306B569CBB6AD6571E12EB5C9477D3A57180C7B') WHERE ruc = '20613954768';
UPDATE empresa SET sunat_sol_usuario = UNHEX('556804414BD6956908D2AADF4268ED1837403CFD6D21670EE6A7AF2D159C77CADEA1F65E'), sunat_sol_password = UNHEX('23EE6DDCE90C1DB0F23FBC30205D7C375A1376A7F517A25D45CD8C0350A8AD889738F3B1') WHERE ruc = '20612385328';
UPDATE empresa SET sunat_sol_usuario = UNHEX('F383B084363D41ACE17211A3256A95B75301832477D19A47D9CB5CE7A71042D99C806C80'), sunat_sol_password = UNHEX('CB7AA1622727059E13B6868DC137C6DA4F7706671D9CE5D6277FFE8D78CB76A023303A4FD8') WHERE ruc = '20610936548';
UPDATE empresa SET sunat_sol_usuario = UNHEX('7D1D9A56CD8A0F52C3BAF281599EAD7282CC60432B69A2632D7C67CA2B7590825865E8B3'), sunat_sol_password = UNHEX('B05289560A888A4311E18D58CC0AD4E191445EF0C44B5DDA90C6B2D5989C3385AB94C21FA9') WHERE ruc = '10160137288';
UPDATE empresa SET sunat_sol_usuario = UNHEX('CD4A2AB41A87BCE7B426752B4A4ABF1E67A401D7DA7DFABBEF5555FB669C8F30D7A70F98'), sunat_sol_password = UNHEX('E19109120EB270D7A191EFCF384E00A29E290E66683E0A95D03085FC8687EE87C894DDAF') WHERE ruc = '10464707218';
UPDATE empresa SET sunat_sol_usuario = UNHEX('ABEF47CF809A1B0E41FA696D9554DC3D9D7BACD373D45AC43100DDA75D13D517CA6B3C14'), sunat_sol_password = UNHEX('B3333B115094790798229EC1C8B95C17B2AF7FA311B78B40CF2204D1832DD610932A0ACDA1') WHERE ruc = '15481540779';
UPDATE empresa SET sunat_sol_usuario = UNHEX('348F6969705FBC988A58B78358DAFA71F03D16E3D2095D3F31FD2621F9C2FE24255CCA37'), sunat_sol_password = UNHEX('17DC0C856402633A8BB54B7D46386FD10E6CB3EF7D5E37D588D056D50EF75DC0D6447677') WHERE ruc = '20611996889';
UPDATE empresa SET sunat_sol_usuario = UNHEX('012D09BDE92708003A81FD3C0118C3CD3268AE242507A6565E8689391F291AD0D4F33F9A'), sunat_sol_password = UNHEX('87BE6F283F9A74C582E5E293C752CF83FE241155647E4D032DA706001309704B9F5FEE00F6') WHERE ruc = '10178227829';
UPDATE empresa SET sunat_sol_usuario = UNHEX('BEBDB8278D4C490D9E717E87AC598B11B32F062B73956CF86169C8E9261E47E9B271E2D2'), sunat_sol_password = UNHEX('111C53705EFF31B8E72E584DEB8B8102C076264BAD051FE7226A408D62100E626662423D5B04DC') WHERE ruc = '20605089489';
UPDATE empresa SET sunat_sol_usuario = UNHEX('FE82E92DCD6E91C9305CF6DD4B84E7DA6DDF3680CAEFE409CA28DF4FBEC075F0C2494FF2'), sunat_sol_password = UNHEX('036664BBF70257E9EAEABD64DAD77F5F0C9E49190F3473A655056D0DF85CE4FEAA6E51AD0A51A67D') WHERE ruc = '20609811669';
UPDATE empresa SET sunat_sol_usuario = UNHEX('20178474A19D8E1BA5D282482149AB704F4C90A6D32A2AD4A10B6E007C73D0B5D6D4276C'), sunat_sol_password = UNHEX('CFE84EF133788EED16E7DE7B692BC9200B6EF34EC69DBDE4C30A1F67191D51BE7B17F664D6') WHERE ruc = '20604985049';
UPDATE empresa SET sunat_sol_usuario = UNHEX('C6BBCC33AA0C51285050BF89A4D38FA2B5F9C552880F3120B999BCB98E9310BE65E55459'), sunat_sol_password = UNHEX('DA6DCC9BA11904F1542D8F0C831DE9B49BD50F916FE846340F2A81DE6EFD5FE3F8FEDCA95F') WHERE ruc = '20613608789';
UPDATE empresa SET sunat_sol_usuario = UNHEX('8ECDECCB32CE0A07D928472D763D9936E66B806B65C2146F07627B95E5B2E7933DCFBF0E'), sunat_sol_password = UNHEX('EAD89C5674325F415279CC02455DEA9E35BEB500B92DC3D9FE7F65CB931239FB37A09D9BC3') WHERE ruc = '20613392069';
UPDATE empresa SET sunat_sol_usuario = UNHEX('D3E1A3B23EA50672F7A7ACC54FC4927C3D762F831A6FC219326D7A93282009D55DA8F013'), sunat_sol_password = UNHEX('54ED1090D46D5E6DF720310FB28DA9A58D25B111F5F0B5AD2D84BCE4BA0E4DE8369B0DA4') WHERE ruc = '20608331299';
UPDATE empresa SET sunat_sol_usuario = UNHEX('22EB0F1CC3404F381579269E41BAE5FF8ED0A0E113287EC51ECB4FDA4027738465BF0ED8'), sunat_sol_password = UNHEX('DE23EC34F57751B152D6C44C3EF44A9A198CC623CB957F229E664D941A7BDD21D6AAC35E') WHERE ruc = '10426900489';
UPDATE empresa SET sunat_sol_usuario = UNHEX('FE293725FBBD5F3DF70CE0B81570B4B43C3B919CEBA972504A2918CF210CA07E389D6541'), sunat_sol_password = UNHEX('AF6D237B771A083036BB7327BEE413300947E24EBF477DF278DF522A2DC3E83EC861087F') WHERE ruc = '20525491839';
UPDATE empresa SET sunat_sol_usuario = UNHEX('39AA7BFB2619C1D66A54C1EAB12F37546A7CB8012BE7DA7550071BF27C7A197F76117B17'), sunat_sol_password = UNHEX('C55A4D37014701A43C62FCE5CC2466BC87AD87FF9F373A204AF6C885B2B6E12EF8F55E3F64') WHERE ruc = '10445244169';
UPDATE empresa SET sunat_sol_usuario = UNHEX('777891171EE2710DBEFC9D3153A2C5EB70F5A1C8C010D397DEB03EE31B4D2CCC3006E9BD'), sunat_sol_password = UNHEX('550625FE02FDFAB43418079ACD6296034C4DE3A9B6501A8AA26A145CA067E403674554B2BBF7') WHERE ruc = '20530093019';
UPDATE empresa SET sunat_sol_usuario = UNHEX('E89FE708FA5348D279041E562EE459E63A47728537623EFC35E2CB9CE6E6633435FF75C1'), sunat_sol_password = UNHEX('B44CC8A01D572856ECD1F77337A941AF42CE54C4D0FF618C5A66C9D34C138E2AAFED18') WHERE ruc = '20615420159';
UPDATE empresa SET sunat_sol_usuario = UNHEX('6CACB804283DC03A885E301A2FAB829421904EF58871C9891B2AC133228E4C9691F89A90'), sunat_sol_password = UNHEX('C67A4FEB59DF7299D33ADF6BF56F028DAC31BB4CF598D39D1A2D4E693EB1934DAA00F8A1A2') WHERE ruc = '10004617229';

-- Cronograma real 2026, migrado desde "Control de Vencimientos_EBA.xlsm" (pestaña CRONOGRAMAS 2026)
-- IGV_RENTA y PLANILLA comparten fecha (columna "PDT MENSUAL" del Excel).
-- AFP_NET no varía por dígito de RUC (una sola fecha por mes), por eso solo aparece en el dígito 0.
INSERT INTO cronograma_vencimiento (anio, mes, digito_ruc, tipo_obligacion, fecha_limite) VALUES
(2026, 1, 0, 'IGV_RENTA', '2026-02-16'),
(2026, 1, 0, 'PLANILLA', '2026-02-16'),
(2026, 1, 0, 'RCE_RVIE_SIRE', '2026-02-13'),
(2026, 1, 0, 'AFP_NET', '2026-02-06'),
(2026, 2, 0, 'IGV_RENTA', '2026-03-16'),
(2026, 2, 0, 'PLANILLA', '2026-03-16'),
(2026, 2, 0, 'RCE_RVIE_SIRE', '2026-03-13'),
(2026, 2, 0, 'AFP_NET', '2026-03-06'),
(2026, 3, 0, 'IGV_RENTA', '2026-04-17'),
(2026, 3, 0, 'PLANILLA', '2026-04-17'),
(2026, 3, 0, 'RCE_RVIE_SIRE', '2026-04-16'),
(2026, 3, 0, 'AFP_NET', '2026-04-07'),
(2026, 4, 0, 'IGV_RENTA', '2026-05-18'),
(2026, 4, 0, 'PLANILLA', '2026-05-18'),
(2026, 4, 0, 'RCE_RVIE_SIRE', '2026-05-15'),
(2026, 4, 0, 'AFP_NET', '2026-05-07'),
(2026, 5, 0, 'IGV_RENTA', '2026-06-15'),
(2026, 5, 0, 'PLANILLA', '2026-06-15'),
(2026, 5, 0, 'RCE_RVIE_SIRE', '2026-06-12'),
(2026, 5, 0, 'AFP_NET', '2026-06-05'),
(2026, 6, 0, 'IGV_RENTA', '2026-07-15'),
(2026, 6, 0, 'PLANILLA', '2026-07-15'),
(2026, 6, 0, 'RCE_RVIE_SIRE', '2026-07-14'),
(2026, 6, 0, 'AFP_NET', '2026-07-07'),
(2026, 7, 0, 'IGV_RENTA', '2026-08-18'),
(2026, 7, 0, 'PLANILLA', '2026-08-18'),
(2026, 7, 0, 'RCE_RVIE_SIRE', '2026-08-17'),
(2026, 7, 0, 'AFP_NET', '2026-08-07'),
(2026, 8, 0, 'IGV_RENTA', '2026-09-15'),
(2026, 8, 0, 'PLANILLA', '2026-09-15'),
(2026, 8, 0, 'RCE_RVIE_SIRE', '2026-09-14'),
(2026, 8, 0, 'AFP_NET', '2026-09-07'),
(2026, 9, 0, 'IGV_RENTA', '2026-10-16'),
(2026, 9, 0, 'PLANILLA', '2026-10-16'),
(2026, 9, 0, 'RCE_RVIE_SIRE', '2026-10-15'),
(2026, 9, 0, 'AFP_NET', '2026-10-07'),
(2026, 10, 0, 'IGV_RENTA', '2026-11-16'),
(2026, 10, 0, 'PLANILLA', '2026-11-16'),
(2026, 10, 0, 'RCE_RVIE_SIRE', '2026-11-13'),
(2026, 10, 0, 'AFP_NET', '2026-11-06'),
(2026, 11, 0, 'IGV_RENTA', '2026-12-17'),
(2026, 11, 0, 'PLANILLA', '2026-12-17'),
(2026, 11, 0, 'RCE_RVIE_SIRE', '2026-12-16'),
(2026, 11, 0, 'AFP_NET', '2026-12-07'),
(2026, 12, 0, 'IGV_RENTA', '2027-01-18'),
(2026, 12, 0, 'PLANILLA', '2027-01-18'),
(2026, 12, 0, 'RCE_RVIE_SIRE', '2027-01-15'),
(2026, 12, 0, 'AFP_NET', '2027-01-08'),
(2026, 1, 1, 'IGV_RENTA', '2026-02-17'),
(2026, 1, 1, 'PLANILLA', '2026-02-17'),
(2026, 1, 1, 'RCE_RVIE_SIRE', '2026-02-16'),
(2026, 2, 1, 'IGV_RENTA', '2026-03-17'),
(2026, 2, 1, 'PLANILLA', '2026-03-17'),
(2026, 2, 1, 'RCE_RVIE_SIRE', '2026-03-16'),
(2026, 3, 1, 'IGV_RENTA', '2026-04-20'),
(2026, 3, 1, 'PLANILLA', '2026-04-20'),
(2026, 3, 1, 'RCE_RVIE_SIRE', '2026-04-17'),
(2026, 4, 1, 'IGV_RENTA', '2026-05-19'),
(2026, 4, 1, 'PLANILLA', '2026-05-19'),
(2026, 4, 1, 'RCE_RVIE_SIRE', '2026-05-18'),
(2026, 5, 1, 'IGV_RENTA', '2026-06-16'),
(2026, 5, 1, 'PLANILLA', '2026-06-16'),
(2026, 5, 1, 'RCE_RVIE_SIRE', '2026-06-15'),
(2026, 6, 1, 'IGV_RENTA', '2026-07-16'),
(2026, 6, 1, 'PLANILLA', '2026-07-16'),
(2026, 6, 1, 'RCE_RVIE_SIRE', '2026-07-15'),
(2026, 7, 1, 'IGV_RENTA', '2026-08-19'),
(2026, 7, 1, 'PLANILLA', '2026-08-19'),
(2026, 7, 1, 'RCE_RVIE_SIRE', '2026-08-18'),
(2026, 8, 1, 'IGV_RENTA', '2026-09-16'),
(2026, 8, 1, 'PLANILLA', '2026-09-16'),
(2026, 8, 1, 'RCE_RVIE_SIRE', '2026-09-15'),
(2026, 9, 1, 'IGV_RENTA', '2026-10-19'),
(2026, 9, 1, 'PLANILLA', '2026-10-19'),
(2026, 9, 1, 'RCE_RVIE_SIRE', '2026-10-16'),
(2026, 10, 1, 'IGV_RENTA', '2026-11-17'),
(2026, 10, 1, 'PLANILLA', '2026-11-17'),
(2026, 10, 1, 'RCE_RVIE_SIRE', '2026-11-16'),
(2026, 11, 1, 'IGV_RENTA', '2026-12-18'),
(2026, 11, 1, 'PLANILLA', '2026-12-18'),
(2026, 11, 1, 'RCE_RVIE_SIRE', '2026-12-17'),
(2026, 12, 1, 'IGV_RENTA', '2027-01-19'),
(2026, 12, 1, 'PLANILLA', '2027-01-19'),
(2026, 12, 1, 'RCE_RVIE_SIRE', '2027-01-18'),
(2026, 1, 2, 'IGV_RENTA', '2026-02-18'),
(2026, 1, 2, 'PLANILLA', '2026-02-18'),
(2026, 1, 2, 'RCE_RVIE_SIRE', '2026-02-17'),
(2026, 2, 2, 'IGV_RENTA', '2026-03-18'),
(2026, 2, 2, 'PLANILLA', '2026-03-18'),
(2026, 2, 2, 'RCE_RVIE_SIRE', '2026-03-17'),
(2026, 3, 2, 'IGV_RENTA', '2026-04-21'),
(2026, 3, 2, 'PLANILLA', '2026-04-21'),
(2026, 3, 2, 'RCE_RVIE_SIRE', '2026-04-20'),
(2026, 4, 2, 'IGV_RENTA', '2026-05-20'),
(2026, 4, 2, 'PLANILLA', '2026-05-20'),
(2026, 4, 2, 'RCE_RVIE_SIRE', '2026-05-19'),
(2026, 5, 2, 'IGV_RENTA', '2026-06-17'),
(2026, 5, 2, 'PLANILLA', '2026-06-17'),
(2026, 5, 2, 'RCE_RVIE_SIRE', '2026-06-16'),
(2026, 6, 2, 'IGV_RENTA', '2026-07-17'),
(2026, 6, 2, 'PLANILLA', '2026-07-17'),
(2026, 6, 2, 'RCE_RVIE_SIRE', '2026-07-16'),
(2026, 7, 2, 'IGV_RENTA', '2026-08-20'),
(2026, 7, 2, 'PLANILLA', '2026-08-20'),
(2026, 7, 2, 'RCE_RVIE_SIRE', '2026-08-19'),
(2026, 8, 2, 'IGV_RENTA', '2026-09-17'),
(2026, 8, 2, 'PLANILLA', '2026-09-17'),
(2026, 8, 2, 'RCE_RVIE_SIRE', '2026-09-16'),
(2026, 9, 2, 'IGV_RENTA', '2026-10-20'),
(2026, 9, 2, 'PLANILLA', '2026-10-20'),
(2026, 9, 2, 'RCE_RVIE_SIRE', '2026-10-19'),
(2026, 10, 2, 'IGV_RENTA', '2026-11-18'),
(2026, 10, 2, 'PLANILLA', '2026-11-18'),
(2026, 10, 2, 'RCE_RVIE_SIRE', '2026-11-17'),
(2026, 11, 2, 'IGV_RENTA', '2026-12-21'),
(2026, 11, 2, 'PLANILLA', '2026-12-21'),
(2026, 11, 2, 'RCE_RVIE_SIRE', '2026-12-18'),
(2026, 12, 2, 'IGV_RENTA', '2027-01-20'),
(2026, 12, 2, 'PLANILLA', '2027-01-20'),
(2026, 12, 2, 'RCE_RVIE_SIRE', '2027-01-19'),
(2026, 1, 3, 'IGV_RENTA', '2026-02-18'),
(2026, 1, 3, 'PLANILLA', '2026-02-18'),
(2026, 1, 3, 'RCE_RVIE_SIRE', '2026-02-17'),
(2026, 2, 3, 'IGV_RENTA', '2026-03-18'),
(2026, 2, 3, 'PLANILLA', '2026-03-18'),
(2026, 2, 3, 'RCE_RVIE_SIRE', '2026-03-17'),
(2026, 3, 3, 'IGV_RENTA', '2026-04-21'),
(2026, 3, 3, 'PLANILLA', '2026-04-21'),
(2026, 3, 3, 'RCE_RVIE_SIRE', '2026-04-20'),
(2026, 4, 3, 'IGV_RENTA', '2026-05-20'),
(2026, 4, 3, 'PLANILLA', '2026-05-20'),
(2026, 4, 3, 'RCE_RVIE_SIRE', '2026-05-19'),
(2026, 5, 3, 'IGV_RENTA', '2026-06-17'),
(2026, 5, 3, 'PLANILLA', '2026-06-17'),
(2026, 5, 3, 'RCE_RVIE_SIRE', '2026-06-16'),
(2026, 6, 3, 'IGV_RENTA', '2026-07-17'),
(2026, 6, 3, 'PLANILLA', '2026-07-17'),
(2026, 6, 3, 'RCE_RVIE_SIRE', '2026-07-16'),
(2026, 7, 3, 'IGV_RENTA', '2026-08-20'),
(2026, 7, 3, 'PLANILLA', '2026-08-20'),
(2026, 7, 3, 'RCE_RVIE_SIRE', '2026-08-19'),
(2026, 8, 3, 'IGV_RENTA', '2026-09-17'),
(2026, 8, 3, 'PLANILLA', '2026-09-17'),
(2026, 8, 3, 'RCE_RVIE_SIRE', '2026-09-16'),
(2026, 9, 3, 'IGV_RENTA', '2026-10-20'),
(2026, 9, 3, 'PLANILLA', '2026-10-20'),
(2026, 9, 3, 'RCE_RVIE_SIRE', '2026-10-19'),
(2026, 10, 3, 'IGV_RENTA', '2026-11-18'),
(2026, 10, 3, 'PLANILLA', '2026-11-18'),
(2026, 10, 3, 'RCE_RVIE_SIRE', '2026-11-17'),
(2026, 11, 3, 'IGV_RENTA', '2026-12-21'),
(2026, 11, 3, 'PLANILLA', '2026-12-21'),
(2026, 11, 3, 'RCE_RVIE_SIRE', '2026-12-18'),
(2026, 12, 3, 'IGV_RENTA', '2027-01-20'),
(2026, 12, 3, 'PLANILLA', '2027-01-20'),
(2026, 12, 3, 'RCE_RVIE_SIRE', '2027-01-19'),
(2026, 1, 4, 'IGV_RENTA', '2026-02-19'),
(2026, 1, 4, 'PLANILLA', '2026-02-19'),
(2026, 1, 4, 'RCE_RVIE_SIRE', '2026-02-18'),
(2026, 2, 4, 'IGV_RENTA', '2026-03-19'),
(2026, 2, 4, 'PLANILLA', '2026-03-19'),
(2026, 2, 4, 'RCE_RVIE_SIRE', '2026-03-18'),
(2026, 3, 4, 'IGV_RENTA', '2026-04-22'),
(2026, 3, 4, 'PLANILLA', '2026-04-22'),
(2026, 3, 4, 'RCE_RVIE_SIRE', '2026-04-21'),
(2026, 4, 4, 'IGV_RENTA', '2026-05-21'),
(2026, 4, 4, 'PLANILLA', '2026-05-21'),
(2026, 4, 4, 'RCE_RVIE_SIRE', '2026-05-20'),
(2026, 5, 4, 'IGV_RENTA', '2026-06-18'),
(2026, 5, 4, 'PLANILLA', '2026-06-18'),
(2026, 5, 4, 'RCE_RVIE_SIRE', '2026-06-17'),
(2026, 6, 4, 'IGV_RENTA', '2026-07-20'),
(2026, 6, 4, 'PLANILLA', '2026-07-20'),
(2026, 6, 4, 'RCE_RVIE_SIRE', '2026-07-17'),
(2026, 7, 4, 'IGV_RENTA', '2026-08-21'),
(2026, 7, 4, 'PLANILLA', '2026-08-21'),
(2026, 7, 4, 'RCE_RVIE_SIRE', '2026-08-20'),
(2026, 8, 4, 'IGV_RENTA', '2026-09-18'),
(2026, 8, 4, 'PLANILLA', '2026-09-18'),
(2026, 8, 4, 'RCE_RVIE_SIRE', '2026-09-17'),
(2026, 9, 4, 'IGV_RENTA', '2026-10-21'),
(2026, 9, 4, 'PLANILLA', '2026-10-21'),
(2026, 9, 4, 'RCE_RVIE_SIRE', '2026-10-20'),
(2026, 10, 4, 'IGV_RENTA', '2026-11-19'),
(2026, 10, 4, 'PLANILLA', '2026-11-19'),
(2026, 10, 4, 'RCE_RVIE_SIRE', '2026-11-18'),
(2026, 11, 4, 'IGV_RENTA', '2026-12-22'),
(2026, 11, 4, 'PLANILLA', '2026-12-22'),
(2026, 11, 4, 'RCE_RVIE_SIRE', '2026-12-21'),
(2026, 12, 4, 'IGV_RENTA', '2027-01-21'),
(2026, 12, 4, 'PLANILLA', '2027-01-21'),
(2026, 12, 4, 'RCE_RVIE_SIRE', '2027-01-20'),
(2026, 1, 5, 'IGV_RENTA', '2026-02-19'),
(2026, 1, 5, 'PLANILLA', '2026-02-19'),
(2026, 1, 5, 'RCE_RVIE_SIRE', '2026-02-18'),
(2026, 2, 5, 'IGV_RENTA', '2026-03-19'),
(2026, 2, 5, 'PLANILLA', '2026-03-19'),
(2026, 2, 5, 'RCE_RVIE_SIRE', '2026-03-18'),
(2026, 3, 5, 'IGV_RENTA', '2026-04-22'),
(2026, 3, 5, 'PLANILLA', '2026-04-22'),
(2026, 3, 5, 'RCE_RVIE_SIRE', '2026-04-21'),
(2026, 4, 5, 'IGV_RENTA', '2026-05-21'),
(2026, 4, 5, 'PLANILLA', '2026-05-21'),
(2026, 4, 5, 'RCE_RVIE_SIRE', '2026-05-20'),
(2026, 5, 5, 'IGV_RENTA', '2026-06-18'),
(2026, 5, 5, 'PLANILLA', '2026-06-18'),
(2026, 5, 5, 'RCE_RVIE_SIRE', '2026-06-17'),
(2026, 6, 5, 'IGV_RENTA', '2026-07-20'),
(2026, 6, 5, 'PLANILLA', '2026-07-20'),
(2026, 6, 5, 'RCE_RVIE_SIRE', '2026-07-17'),
(2026, 7, 5, 'IGV_RENTA', '2026-08-21'),
(2026, 7, 5, 'PLANILLA', '2026-08-21'),
(2026, 7, 5, 'RCE_RVIE_SIRE', '2026-08-20'),
(2026, 8, 5, 'IGV_RENTA', '2026-09-18'),
(2026, 8, 5, 'PLANILLA', '2026-09-18'),
(2026, 8, 5, 'RCE_RVIE_SIRE', '2026-09-17'),
(2026, 9, 5, 'IGV_RENTA', '2026-10-21'),
(2026, 9, 5, 'PLANILLA', '2026-10-21'),
(2026, 9, 5, 'RCE_RVIE_SIRE', '2026-10-20'),
(2026, 10, 5, 'IGV_RENTA', '2026-11-19'),
(2026, 10, 5, 'PLANILLA', '2026-11-19'),
(2026, 10, 5, 'RCE_RVIE_SIRE', '2026-11-18'),
(2026, 11, 5, 'IGV_RENTA', '2026-12-22'),
(2026, 11, 5, 'PLANILLA', '2026-12-22'),
(2026, 11, 5, 'RCE_RVIE_SIRE', '2026-12-21'),
(2026, 12, 5, 'IGV_RENTA', '2027-01-21'),
(2026, 12, 5, 'PLANILLA', '2027-01-21'),
(2026, 12, 5, 'RCE_RVIE_SIRE', '2027-01-20'),
(2026, 1, 6, 'IGV_RENTA', '2026-02-20'),
(2026, 1, 6, 'PLANILLA', '2026-02-20'),
(2026, 1, 6, 'RCE_RVIE_SIRE', '2026-02-19'),
(2026, 2, 6, 'IGV_RENTA', '2026-03-20'),
(2026, 2, 6, 'PLANILLA', '2026-03-20'),
(2026, 2, 6, 'RCE_RVIE_SIRE', '2026-03-19'),
(2026, 3, 6, 'IGV_RENTA', '2026-04-23'),
(2026, 3, 6, 'PLANILLA', '2026-04-23'),
(2026, 3, 6, 'RCE_RVIE_SIRE', '2026-04-22'),
(2026, 4, 6, 'IGV_RENTA', '2026-05-22'),
(2026, 4, 6, 'PLANILLA', '2026-05-22'),
(2026, 4, 6, 'RCE_RVIE_SIRE', '2026-05-21'),
(2026, 5, 6, 'IGV_RENTA', '2026-06-19'),
(2026, 5, 6, 'PLANILLA', '2026-06-19'),
(2026, 5, 6, 'RCE_RVIE_SIRE', '2026-06-18'),
(2026, 6, 6, 'IGV_RENTA', '2026-07-21'),
(2026, 6, 6, 'PLANILLA', '2026-07-21'),
(2026, 6, 6, 'RCE_RVIE_SIRE', '2026-07-20'),
(2026, 7, 6, 'IGV_RENTA', '2026-08-24'),
(2026, 7, 6, 'PLANILLA', '2026-08-24'),
(2026, 7, 6, 'RCE_RVIE_SIRE', '2026-08-21'),
(2026, 8, 6, 'IGV_RENTA', '2026-09-21'),
(2026, 8, 6, 'PLANILLA', '2026-09-21'),
(2026, 8, 6, 'RCE_RVIE_SIRE', '2026-09-18'),
(2026, 9, 6, 'IGV_RENTA', '2026-10-22'),
(2026, 9, 6, 'PLANILLA', '2026-10-22'),
(2026, 9, 6, 'RCE_RVIE_SIRE', '2026-10-21'),
(2026, 10, 6, 'IGV_RENTA', '2026-11-20'),
(2026, 10, 6, 'PLANILLA', '2026-11-20'),
(2026, 10, 6, 'RCE_RVIE_SIRE', '2026-11-19'),
(2026, 11, 6, 'IGV_RENTA', '2026-12-23'),
(2026, 11, 6, 'PLANILLA', '2026-12-23'),
(2026, 11, 6, 'RCE_RVIE_SIRE', '2026-12-22'),
(2026, 12, 6, 'IGV_RENTA', '2027-01-22'),
(2026, 12, 6, 'PLANILLA', '2027-01-22'),
(2026, 12, 6, 'RCE_RVIE_SIRE', '2027-01-21'),
(2026, 1, 7, 'IGV_RENTA', '2026-02-20'),
(2026, 1, 7, 'PLANILLA', '2026-02-20'),
(2026, 1, 7, 'RCE_RVIE_SIRE', '2026-02-19'),
(2026, 2, 7, 'IGV_RENTA', '2026-03-20'),
(2026, 2, 7, 'PLANILLA', '2026-03-20'),
(2026, 2, 7, 'RCE_RVIE_SIRE', '2026-03-19'),
(2026, 3, 7, 'IGV_RENTA', '2026-04-23'),
(2026, 3, 7, 'PLANILLA', '2026-04-23'),
(2026, 3, 7, 'RCE_RVIE_SIRE', '2026-04-22'),
(2026, 4, 7, 'IGV_RENTA', '2026-05-22'),
(2026, 4, 7, 'PLANILLA', '2026-05-22'),
(2026, 4, 7, 'RCE_RVIE_SIRE', '2026-05-21'),
(2026, 5, 7, 'IGV_RENTA', '2026-06-19'),
(2026, 5, 7, 'PLANILLA', '2026-06-19'),
(2026, 5, 7, 'RCE_RVIE_SIRE', '2026-06-18'),
(2026, 6, 7, 'IGV_RENTA', '2026-07-21'),
(2026, 6, 7, 'PLANILLA', '2026-07-21'),
(2026, 6, 7, 'RCE_RVIE_SIRE', '2026-07-20'),
(2026, 7, 7, 'IGV_RENTA', '2026-08-24'),
(2026, 7, 7, 'PLANILLA', '2026-08-24'),
(2026, 7, 7, 'RCE_RVIE_SIRE', '2026-08-21'),
(2026, 8, 7, 'IGV_RENTA', '2026-09-21'),
(2026, 8, 7, 'PLANILLA', '2026-09-21'),
(2026, 8, 7, 'RCE_RVIE_SIRE', '2026-09-18'),
(2026, 9, 7, 'IGV_RENTA', '2026-10-22'),
(2026, 9, 7, 'PLANILLA', '2026-10-22'),
(2026, 9, 7, 'RCE_RVIE_SIRE', '2026-10-21'),
(2026, 10, 7, 'IGV_RENTA', '2026-11-20'),
(2026, 10, 7, 'PLANILLA', '2026-11-20'),
(2026, 10, 7, 'RCE_RVIE_SIRE', '2026-11-19'),
(2026, 11, 7, 'IGV_RENTA', '2026-12-23'),
(2026, 11, 7, 'PLANILLA', '2026-12-23'),
(2026, 11, 7, 'RCE_RVIE_SIRE', '2026-12-22'),
(2026, 12, 7, 'IGV_RENTA', '2027-01-22'),
(2026, 12, 7, 'PLANILLA', '2027-01-22'),
(2026, 12, 7, 'RCE_RVIE_SIRE', '2027-01-21'),
(2026, 1, 8, 'IGV_RENTA', '2026-02-23'),
(2026, 1, 8, 'PLANILLA', '2026-02-23'),
(2026, 1, 8, 'RCE_RVIE_SIRE', '2026-02-20'),
(2026, 2, 8, 'IGV_RENTA', '2026-03-23'),
(2026, 2, 8, 'PLANILLA', '2026-03-23'),
(2026, 2, 8, 'RCE_RVIE_SIRE', '2026-03-20'),
(2026, 3, 8, 'IGV_RENTA', '2026-04-24'),
(2026, 3, 8, 'PLANILLA', '2026-04-24'),
(2026, 3, 8, 'RCE_RVIE_SIRE', '2026-04-23'),
(2026, 4, 8, 'IGV_RENTA', '2026-05-25'),
(2026, 4, 8, 'PLANILLA', '2026-05-25'),
(2026, 4, 8, 'RCE_RVIE_SIRE', '2026-05-22'),
(2026, 5, 8, 'IGV_RENTA', '2026-06-22'),
(2026, 5, 8, 'PLANILLA', '2026-06-22'),
(2026, 5, 8, 'RCE_RVIE_SIRE', '2026-06-19'),
(2026, 6, 8, 'IGV_RENTA', '2026-07-22'),
(2026, 6, 8, 'PLANILLA', '2026-07-22'),
(2026, 6, 8, 'RCE_RVIE_SIRE', '2026-07-21'),
(2026, 7, 8, 'IGV_RENTA', '2026-08-25'),
(2026, 7, 8, 'PLANILLA', '2026-08-25'),
(2026, 7, 8, 'RCE_RVIE_SIRE', '2026-08-24'),
(2026, 8, 8, 'IGV_RENTA', '2026-09-22'),
(2026, 8, 8, 'PLANILLA', '2026-09-22'),
(2026, 8, 8, 'RCE_RVIE_SIRE', '2026-09-21'),
(2026, 9, 8, 'IGV_RENTA', '2026-10-23'),
(2026, 9, 8, 'PLANILLA', '2026-10-23'),
(2026, 9, 8, 'RCE_RVIE_SIRE', '2026-10-22'),
(2026, 10, 8, 'IGV_RENTA', '2026-11-23'),
(2026, 10, 8, 'PLANILLA', '2026-11-23'),
(2026, 10, 8, 'RCE_RVIE_SIRE', '2026-11-20'),
(2026, 11, 8, 'IGV_RENTA', '2026-12-24'),
(2026, 11, 8, 'PLANILLA', '2026-12-24'),
(2026, 11, 8, 'RCE_RVIE_SIRE', '2026-12-23'),
(2026, 12, 8, 'IGV_RENTA', '2027-01-25'),
(2026, 12, 8, 'PLANILLA', '2027-01-25'),
(2026, 12, 8, 'RCE_RVIE_SIRE', '2027-01-22'),
(2026, 1, 9, 'IGV_RENTA', '2026-02-23'),
(2026, 1, 9, 'PLANILLA', '2026-02-23'),
(2026, 1, 9, 'RCE_RVIE_SIRE', '2026-02-20'),
(2026, 2, 9, 'IGV_RENTA', '2026-03-23'),
(2026, 2, 9, 'PLANILLA', '2026-03-23'),
(2026, 2, 9, 'RCE_RVIE_SIRE', '2026-03-20'),
(2026, 3, 9, 'IGV_RENTA', '2026-04-24'),
(2026, 3, 9, 'PLANILLA', '2026-04-24'),
(2026, 3, 9, 'RCE_RVIE_SIRE', '2026-04-23'),
(2026, 4, 9, 'IGV_RENTA', '2026-05-25'),
(2026, 4, 9, 'PLANILLA', '2026-05-25'),
(2026, 4, 9, 'RCE_RVIE_SIRE', '2026-05-22'),
(2026, 5, 9, 'IGV_RENTA', '2026-06-22'),
(2026, 5, 9, 'PLANILLA', '2026-06-22'),
(2026, 5, 9, 'RCE_RVIE_SIRE', '2026-06-19'),
(2026, 6, 9, 'IGV_RENTA', '2026-07-22'),
(2026, 6, 9, 'PLANILLA', '2026-07-22'),
(2026, 6, 9, 'RCE_RVIE_SIRE', '2026-07-21'),
(2026, 7, 9, 'IGV_RENTA', '2026-08-25'),
(2026, 7, 9, 'PLANILLA', '2026-08-25'),
(2026, 7, 9, 'RCE_RVIE_SIRE', '2026-08-24'),
(2026, 8, 9, 'IGV_RENTA', '2026-09-22'),
(2026, 8, 9, 'PLANILLA', '2026-09-22'),
(2026, 8, 9, 'RCE_RVIE_SIRE', '2026-09-21'),
(2026, 9, 9, 'IGV_RENTA', '2026-10-23'),
(2026, 9, 9, 'PLANILLA', '2026-10-23'),
(2026, 9, 9, 'RCE_RVIE_SIRE', '2026-10-22'),
(2026, 10, 9, 'IGV_RENTA', '2026-11-23'),
(2026, 10, 9, 'PLANILLA', '2026-11-23'),
(2026, 10, 9, 'RCE_RVIE_SIRE', '2026-11-20'),
(2026, 11, 9, 'IGV_RENTA', '2026-12-24'),
(2026, 11, 9, 'PLANILLA', '2026-12-24'),
(2026, 11, 9, 'RCE_RVIE_SIRE', '2026-12-23'),
(2026, 12, 9, 'IGV_RENTA', '2027-01-25'),
(2026, 12, 9, 'PLANILLA', '2027-01-25'),
(2026, 12, 9, 'RCE_RVIE_SIRE', '2027-01-22')
ON DUPLICATE KEY UPDATE fecha_limite = VALUES(fecha_limite);

-- ==============================================================================
-- MIGRACIONES SOBRE BASES YA EXISTENTES
-- ==============================================================================
-- Los CREATE TABLE de arriba son el esquema de referencia para una base NUEVA.
-- Una base que ya está corriendo no se actualiza con ellos: hay que aplicar los
-- ALTER de esta sección.
--
-- Todos usan IF NOT EXISTS (soportado por MariaDB), así que correr el bloque dos
-- veces no falla ni duplica nada. Aplicar en local primero, después en producción.
-- ------------------------------------------------------------------------------

-- 2026-08-23 · auth_refresh_tokens: ventana de gracia para refrescos concurrentes
--
-- Sin estas columnas el login rompe con "Unknown column", porque AuthService ya
-- las escribe al rotar el refresh token.
--
-- Para qué sirven:
--   fecha_revocado  + reemplazado_por → si dos peticiones refrescan a la vez, la
--     segunda llegaba con el token que la primera acababa de rotar y cerraba la
--     sesión ("Sesión expirada" sin motivo). Con estas dos columnas se sigue la
--     cadena de reemplazos durante 15s en vez de cortar. Pasada esa ventana un
--     token ya rotado que reaparece sigue fallando: eso es reuso, no concurrencia.
--   ip_origen + user_agent → auditoría de sesión (desde dónde se emitió cada token).
--
-- Todas admiten NULL: los tokens ya emitidos siguen siendo válidos.

ALTER TABLE `auth_refresh_tokens`
  ADD COLUMN IF NOT EXISTS `fecha_revocado` datetime DEFAULT NULL
    COMMENT 'Cuándo se revocó — habilita la ventana de gracia para refrescos concurrentes',
  ADD COLUMN IF NOT EXISTS `reemplazado_por` int DEFAULT NULL
    COMMENT 'Token que sucedió a este al rotar. Permite seguir la cadena cuando dos pestañas refrescan a la vez, y detectar reuso de token robado',
  ADD COLUMN IF NOT EXISTS `ip_origen` varchar(45) DEFAULT NULL
    COMMENT 'IP desde la que se emitió (IPv6 entra en 45 chars)',
  ADD COLUMN IF NOT EXISTS `user_agent` varchar(255) DEFAULT NULL
    COMMENT 'Navegador/cliente que lo pidió — auditoría de sesión';

ALTER TABLE `auth_refresh_tokens`
  ADD INDEX IF NOT EXISTS `idx_refresh_reemplazado` (`reemplazado_por`);

-- ==============================================================================

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

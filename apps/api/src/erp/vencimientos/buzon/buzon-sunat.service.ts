import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { AuditoriaService } from '@app/common';
import { CredencialesCryptoService } from '../../comun/credenciales-crypto.service';
import { SunatBuzonClient, FilaBuzonSunat } from './sunat-buzon.client';
import { GestionarNotificacionBuzonDto } from './buzon.dto';

const COLS_ORDER_ALLOWED = ['fecha_deposito', 'fecha_sincronizacion', 'id_notificacion', 'tipo_documento'];

/**
 * MÓDULO BUZÓN ELECTRÓNICO SUNAT — alcance de esta fase: LISTAR y GUARDAR EN BD.
 * No descarga adjuntos ni alerta a nadie (ver `sunat-buzon.client.ts` para el
 * porqué del scraping y el estado de verificación de los selectores).
 *
 * Regla de oro heredada de Fase 2 y de la casilla SUNAFIL: si falla la lectura de
 * una empresa NUNCA se asume "sin notificaciones" — queda el error en
 * `sunat_buzon_sincronizacion` con su motivo y el resto de empresas sigue
 * procesándose. Un buzón vacío y un buzón que no se pudo leer son estados
 * distintos, y confundirlos haría que el estudio se pierda una cobranza coactiva.
 */
@Injectable()
export class BuzonSunatService {
  private readonly logger = new Logger(BuzonSunatService.name);

  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private credencialesCrypto: CredencialesCryptoService,
    private buzonClient: SunatBuzonClient,
  ) {}

  // ---------------------------------------------------------------- Lectura ----

  async listarNotificaciones(idEmpresa: number, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;

    const where: string[] = [`id_empresa = ?`, `estado_registro = 'ACTIVO'`];
    const params: any[] = [idEmpresa];
    if (query.estado_gestion) { where.push('estado_gestion = ?'); params.push(query.estado_gestion); }
    if (query.bandeja) { where.push('bandeja = ?'); params.push(query.bandeja); }
    if (query.desde) { where.push('fecha_deposito >= ?'); params.push(query.desde); }
    if (query.hasta) { where.push('fecha_deposito <= ?'); params.push(query.hasta); }
    if (query.buscar) {
      where.push('(asunto LIKE ? OR tipo_documento LIKE ? OR numero_documento LIKE ? OR codigo_notificacion LIKE ?)');
      const like = `%${query.buscar}%`;
      params.push(like, like, like, like);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort) ? query.sort : 'fecha_deposito';
    const sortDir = query.dir === 'ASC' ? 'ASC' : 'DESC';

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT id_notificacion, bandeja, codigo_notificacion, tipo_documento, numero_documento, asunto,
                dependencia, fecha_deposito, leido_en_sunat, estado_gestion, observaciones, fecha_sincronizacion
         FROM sunat_buzon_notificacion ${whereSql}
         ORDER BY ${sortCol} IS NULL, ${sortCol} ${sortDir} LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total FROM sunat_buzon_notificacion ${whereSql}`, params),
    ]);
    return { data, meta: { total: Number(total), page, limit } };
  }

  /**
   * Detalle con la fila cruda incluida — es lo que permite corregir el mapeo de
   * columnas sin volver a golpear el portal si SUNAT le cambia las cabeceras.
   */
  async verNotificacion(idEmpresa: number, id: number) {
    // El WHERE incluye id_empresa a propósito: sin eso, cambiando el id en la URL se
    // leerían notificaciones de otra empresa cliente del estudio.
    const [row] = await this.dataSource.query(
      `SELECT * FROM sunat_buzon_notificacion
       WHERE id_notificacion = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [id, idEmpresa],
    );
    if (!row) throw new NotFoundException('Notificación no encontrada');
    return row;
  }

  async listarSincronizaciones(idEmpresa: number, query: any) {
    const limit = Number(query.limit) || 10;
    return this.dataSource.query(
      `SELECT id_sincronizacion, estado, cantidad_leidas, cantidad_nuevas, mensaje_error, fecha_inicio, fecha_fin
       FROM sunat_buzon_sincronizacion
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO'
       ORDER BY id_sincronizacion DESC LIMIT ?`,
      [idEmpresa, limit],
    );
  }

  // ------------------------------------------------------------- Gestión ----

  async gestionarNotificacion(idEmpresa: number, id: number, dto: GestionarNotificacionBuzonDto, idUsuario: number) {
    const actual = await this.verNotificacion(idEmpresa, id);

    await this.dataSource.query(
      `UPDATE sunat_buzon_notificacion
       SET estado_gestion = ?, observaciones = ?, id_usuario_mod = ?
       WHERE id_notificacion = ? AND id_empresa = ?`,
      [dto.estado_gestion, dto.observaciones ?? actual.observaciones ?? null, idUsuario, id, idEmpresa],
    );

    await this.auditoriaService.registrar(
      'sunat_buzon_notificacion', id, 'ACTUALIZAR', idUsuario,
      { estado_gestion: actual.estado_gestion, observaciones: actual.observaciones },
      { estado_gestion: dto.estado_gestion, observaciones: dto.observaciones ?? actual.observaciones },
    );

    return this.verNotificacion(idEmpresa, id);
  }

  // ------------------------------------------------------- Sincronización ----

  /**
   * Lee el buzón de UNA empresa contra el portal real. Es el disparo del botón
   * "Sincronizar buzón" — una empresa a la vez, que es lo que no arriesga el WAF de
   * SUNAT (a diferencia de recorrer las 171 de un solo clic).
   */
  async sincronizarEmpresa(idEmpresa: number, idUsuario: number) {
    const empresa = await this.obtenerEmpresaConClaveSol(idEmpresa);
    return this.sincronizarUna(empresa, idUsuario);
  }

  /**
   * Recorre TODAS las empresas cliente activas con Clave SOL cargada. Pensado para
   * un disparo controlado (endpoint manual o cron externo), NO para correr varias
   * veces al día: cada empresa abre su propia sesión de navegador contra SUNAT.
   */
  async sincronizarTodas(idUsuario: number) {
    const empresas = await this.dataSource.query(
      `SELECT id_empresa, ruc, sunat_sol_usuario, sunat_sol_password
       FROM empresa
       WHERE estado_registro = 'ACTIVO' AND estado_cliente = 'ACTIVO'
         AND sunat_sol_usuario IS NOT NULL AND sunat_sol_password IS NOT NULL`,
    );

    const resumen = { total: empresas.length, ok: 0, error: 0, nuevas: 0 };
    for (const empresa of empresas) {
      try {
        const r = await this.sincronizarUna(empresa, idUsuario);
        resumen.ok++;
        resumen.nuevas += r.cantidad_nuevas;
      } catch {
        // El detalle ya quedó en sunat_buzon_sincronizacion y en el log: acá solo
        // se cuenta, para que una empresa caída no corte el recorrido.
        resumen.error++;
      }
      // Pausa entre empresas: sin esto, ~170 logins seguidos contra
      // api-seguridad.sunat.gob.pe parecen fuerza bruta y el WAF corta la IP.
      await this.dormir(2500);
    }

    this.logger.log(`Sincronización buzón SUNAT: ${resumen.ok} OK, ${resumen.error} con error, ${resumen.nuevas} notificaciones nuevas, de ${resumen.total} empresas.`);
    return resumen;
  }

  private async sincronizarUna(
    empresa: { id_empresa: number; ruc: string; sunat_sol_usuario: Buffer; sunat_sol_password: Buffer },
    idUsuario: number,
  ) {
    // La bitácora se abre ANTES de tocar SUNAT: si el proceso muere a mitad (timeout,
    // caída del portal), queda la fila EN_PROCESO como rastro de que se intentó.
    const insercion = await this.dataSource.query(
      `INSERT INTO sunat_buzon_sincronizacion (id_empresa, estado, id_usuario_crea) VALUES (?, 'EN_PROCESO', ?)`,
      [empresa.id_empresa, idUsuario],
    );
    const idSincronizacion: number = insercion.insertId;

    try {
      const solUsuario = this.credencialesCrypto.descifrar(empresa.sunat_sol_usuario);
      const solPassword = this.credencialesCrypto.descifrar(empresa.sunat_sol_password);

      const filas = await this.buzonClient.leerBuzon(empresa.ruc, solUsuario, solPassword);
      const nuevas = await this.guardarFilas(empresa.id_empresa, filas, idUsuario);

      await this.dataSource.query(
        `UPDATE sunat_buzon_sincronizacion
         SET estado = 'EXITOSO', cantidad_leidas = ?, cantidad_nuevas = ?, fecha_fin = NOW()
         WHERE id_sincronizacion = ?`,
        [filas.length, nuevas, idSincronizacion],
      );

      this.logger.log(`Buzón SUNAT ${empresa.ruc}: ${filas.length} leídas, ${nuevas} nuevas.`);
      return { id_sincronizacion: idSincronizacion, cantidad_leidas: filas.length, cantidad_nuevas: nuevas };
    } catch (error: any) {
      const mensaje = error?.message ?? 'Error desconocido al leer el buzón de SUNAT';
      await this.dataSource.query(
        `UPDATE sunat_buzon_sincronizacion SET estado = 'ERROR', mensaje_error = ?, fecha_fin = NOW() WHERE id_sincronizacion = ?`,
        [mensaje.slice(0, 1000), idSincronizacion],
      );
      this.logger.error(`Buzón SUNAT falló para ${empresa.ruc}: ${mensaje}`);
      throw error;
    }
  }

  /**
   * Inserta solo lo que todavía no existe, en una sola transacción.
   *
   * Mismo criterio que `sunafil.service.ts`: se consultan primero los hashes ya
   * guardados en vez de usar `INSERT ... ON DUPLICATE KEY UPDATE`, porque así el
   * conteo de "nuevas" es exacto (con ON DUPLICATE, `affectedRows` mezcla
   * inserciones y actualizaciones) y queda imposible pisar por accidente el
   * `estado_gestion`/`observaciones` que ya cargó el encargado sobre una
   * notificación vieja.
   */
  private async guardarFilas(idEmpresa: number, filas: FilaBuzonSunat[], idUsuario: number): Promise<number> {
    if (filas.length === 0) return 0;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const existentes: Array<{ hash_dedupe: string }> = await qr.query(
        `SELECT hash_dedupe FROM sunat_buzon_notificacion WHERE id_empresa = ?`,
        [idEmpresa],
      );
      const yaGuardados = new Set(existentes.map((e) => e.hash_dedupe));

      // Dos filas del portal pueden salir idénticas (mismo asunto y fecha, sin
      // código); sin deduplicar dentro de la propia tanda, el INSERT múltiple
      // reventaría contra el UNIQUE y tumbaría toda la sincronización.
      const vistosEnEstaTanda = new Set<string>();
      const nuevos = filas
        .map((fila) => ({ fila, hash: this.calcularHash(idEmpresa, fila) }))
        .filter(({ hash }) => !yaGuardados.has(hash))
        .filter(({ hash }) => {
          if (vistosEnEstaTanda.has(hash)) return false;
          vistosEnEstaTanda.add(hash);
          return true;
        });

      if (nuevos.length > 0) {
        const values = nuevos.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const params: any[] = [];
        for (const { fila, hash } of nuevos) {
          params.push(
            idEmpresa,
            this.recortar(fila.bandeja, 100),
            this.recortar(fila.codigo_notificacion, 100),
            this.recortar(fila.tipo_documento, 255),
            this.recortar(fila.numero_documento, 100),
            this.recortar(fila.asunto, 500),
            this.recortar(fila.dependencia, 255),
            this.normalizarFecha(fila.fecha_deposito),
            fila.leido_en_sunat ? 1 : 0,
            JSON.stringify(fila.datos_crudos),
            hash,
            idUsuario,
          );
        }
        await qr.query(
          `INSERT INTO sunat_buzon_notificacion
             (id_empresa, bandeja, codigo_notificacion, tipo_documento, numero_documento, asunto,
              dependencia, fecha_deposito, leido_en_sunat, datos_crudos_json, hash_dedupe, id_usuario_crea)
           VALUES ${values}`,
          params,
        );
      }

      await qr.commitTransaction();
      return nuevos.length;
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * Identidad de la fila. Se usa el contenido y no el orden de aparición porque el
   * buzón se re-lee entero en cada corrida y las filas se mueven de página. Si una
   * fila viniera sin código ni número (portal que solo muestre asunto y fecha), el
   * hash igual la distingue por la combinación completa.
   */
  private calcularHash(idEmpresa: number, fila: FilaBuzonSunat): string {
    const partes = [
      idEmpresa,
      fila.codigo_notificacion ?? '',
      fila.numero_documento ?? '',
      fila.tipo_documento ?? '',
      fila.fecha_deposito ?? '',
      fila.asunto ?? '',
    ];
    return createHash('sha256').update(partes.join('|')).digest('hex');
  }

  /**
   * SUNAT muestra las fechas como dd/mm/yyyy (con hora opcional). `new Date()` de
   * JS interpreta "11/06/2026" como mm/dd/yyyy e invierte día y mes — mismo bug ya
   * corregido en `sunat-scraping.client.ts`. Devuelve un Date real porque mysql2 no
   * acepta un string ISO en columnas datetime.
   */
  private normalizarFecha(texto: string | null): Date | null {
    if (!texto) return null;
    const m = texto.trim().match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const [, dd, mm, yyyy, hh, mi, ss] = m;
      return new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh ?? 0), Number(mi ?? 0), Number(ss ?? 0));
    }
    // Formato inesperado: se prefiere null antes que una fecha inventada — el texto
    // original igual queda guardado en datos_crudos_json para revisarlo.
    const fallback = new Date(texto);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  private recortar(texto: string | null, max: number): string | null {
    return texto ? texto.slice(0, max) : null;
  }

  private async obtenerEmpresaConClaveSol(idEmpresa: number) {
    const [empresa] = await this.dataSource.query(
      `SELECT id_empresa, ruc, sunat_sol_usuario, sunat_sol_password
       FROM empresa WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!empresa) throw new NotFoundException('Empresa no encontrada');
    if (!empresa.sunat_sol_usuario || !empresa.sunat_sol_password) {
      throw new BadRequestException('Falta configurar usuario/clave SOL de esta empresa (Empresas → Credenciales SUNAT)');
    }
    return empresa;
  }

  private dormir(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

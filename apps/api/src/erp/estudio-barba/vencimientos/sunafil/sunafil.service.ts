import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { AuditoriaService } from '@app/common';
import { CredencialesCryptoService } from '@app/security';
import { SunafilCasillaClient, FilaCasillaSunafil } from './sunafil-casilla.client';
import { GestionarNotificacionSunafilDto } from './sunafil.dto';

const COLS_ORDER_ALLOWED = ['id_notificacion', 'fecha_deposito', 'fecha_sincronizacion', 'estado_gestion'];

/**
 * CASILLA ELECTRÓNICA SUNAFIL — persistencia y gestión de lo que trae el scraping.
 *
 * SUNAFIL no expone API (ver el porqué, verificado en vivo, en
 * `sunafil-casilla.client.ts`), así que la bandeja se lee con Playwright y se
 * guarda acá para que el estudio la trabaje como una bandeja propia: cada
 * notificación queda con su `estado_gestion` (NUEVA → EN_REVISION → ATENDIDA),
 * independiente de si SUNAFIL la marca leída o no.
 *
 * Dos reglas de oro heredadas de Fase 2 (`sunat-sync.service.ts`):
 *   1. Si la lectura falla, NUNCA se asume "esta empresa no tiene notificaciones"
 *      — queda un registro ERROR en `sunafil_sincronizacion` con el motivo. Una
 *      bandeja vacía por error de scraping y una bandeja realmente vacía se ven
 *      igual en pantalla, y confundirlas puede costar un plazo legal vencido.
 *   2. Re-sincronizar es idempotente: el UNIQUE `(id_empresa, hash_dedupe)` evita
 *      duplicar la misma notificación, y `estado_gestion`/`observaciones` que ya
 *      cargó el encargado NUNCA se pisan al volver a leer el portal.
 *
 * ⚠️ NO hay endpoint de "sincronizar todas las empresas" a propósito. El login
 * pasa por `api-seguridad.sunat.gob.pe`, la misma infraestructura cuyo WAF ya
 * cortó conexiones en las pruebas de Fase 2 tras pocas sesiones seguidas.
 * Recorrer 171 empresas de un clic arriesga el acceso real de los clientes.
 */
@Injectable()
export class SunafilService {
  private readonly logger = new Logger(SunafilService.name);

  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private credencialesCrypto: CredencialesCryptoService,
    private casillaClient: SunafilCasillaClient,
  ) {}

  // ---------------------------------------------------------------- LISTADOS

  async findAll(idEmpresa: number, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const offset = (page - 1) * limit;

    const where: string[] = ['id_empresa = ?', `estado_registro = 'ACTIVO'`];
    const params: any[] = [idEmpresa];

    if (query.estado_gestion) {
      where.push('estado_gestion = ?');
      params.push(query.estado_gestion);
    }
    if (query.search) {
      where.push('(asunto LIKE ? OR numero_expediente LIKE ? OR tipo_documento LIKE ? OR codigo_notificacion LIKE ?)');
      const like = `%${String(query.search).trim()}%`;
      params.push(like, like, like, like);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort) ? query.sort : 'fecha_deposito';
    const sortDir = query.dir === 'ASC' ? 'ASC' : 'DESC';

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT id_notificacion, codigo_notificacion, tipo_documento, asunto, numero_expediente, remitente,
                fecha_deposito, leido_en_sunafil, archivo_ruta, estado_gestion, observaciones, fecha_sincronizacion
         FROM sunafil_notificacion ${whereSql}
         ORDER BY ${sortCol} ${sortDir}, id_notificacion DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total FROM sunafil_notificacion ${whereSql}`, params),
    ]);

    return { data, meta: { total: Number(total), page, limit } };
  }

  /**
   * Cabecera de la pantalla: cuántas notificaciones esperan gestión y cómo salió
   * la última lectura del portal. Lo segundo es lo importante — si la última
   * corrida fue ERROR, la bandeja que se ve abajo está desactualizada y el
   * usuario tiene que saberlo.
   */
  async resumen(idEmpresa: number) {
    const [[conteos], [ultima]] = await Promise.all([
      this.dataSource.query(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(estado_gestion = 'NUEVA'), 0) AS nuevas,
           COALESCE(SUM(estado_gestion = 'EN_REVISION'), 0) AS en_revision
         FROM sunafil_notificacion WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
        [idEmpresa],
      ),
      this.dataSource.query(
        `SELECT id_sincronizacion, estado, cantidad_leidas, cantidad_nuevas, mensaje_error, fecha_inicio, fecha_fin
         FROM sunafil_sincronizacion
         WHERE id_empresa = ? AND estado_registro = 'ACTIVO'
         ORDER BY id_sincronizacion DESC LIMIT 1`,
        [idEmpresa],
      ),
    ]);

    return {
      total: Number(conteos?.total ?? 0),
      nuevas: Number(conteos?.nuevas ?? 0),
      en_revision: Number(conteos?.en_revision ?? 0),
      ultima_sincronizacion: ultima ?? null,
    };
  }

  async historialSincronizaciones(idEmpresa: number, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const offset = (page - 1) * limit;

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT id_sincronizacion, estado, cantidad_leidas, cantidad_nuevas, mensaje_error, fecha_inicio, fecha_fin
         FROM sunafil_sincronizacion
         WHERE id_empresa = ? AND estado_registro = 'ACTIVO'
         ORDER BY id_sincronizacion DESC LIMIT ? OFFSET ?`,
        [idEmpresa, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM sunafil_sincronizacion WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
        [idEmpresa],
      ),
    ]);

    return { data, meta: { total: Number(total), page, limit } };
  }

  // --------------------------------------------------------- SINCRONIZACIÓN

  /**
   * Lee la casilla de UNA empresa contra el portal real y guarda lo nuevo.
   * Deja siempre una fila en `sunafil_sincronizacion`, salga bien o mal.
   */
  async sincronizar(idEmpresa: number, userId: number) {
    const empresa = await this.obtenerEmpresaConCredenciales(idEmpresa);

    const insercion = await this.dataSource.query(
      `INSERT INTO sunafil_sincronizacion (id_empresa, estado, id_usuario_crea) VALUES (?, 'EN_PROCESO', ?)`,
      [idEmpresa, userId],
    );
    const idSincronizacion = Number(insercion.insertId);

    try {
      const filas = await this.casillaClient.leerBandeja(empresa.ruc, empresa.solUsuario, empresa.solPassword);
      const nuevas = await this.guardarNotificaciones(idEmpresa, filas, userId);

      await this.dataSource.query(
        `UPDATE sunafil_sincronizacion
         SET estado = 'EXITOSO', cantidad_leidas = ?, cantidad_nuevas = ?, fecha_fin = NOW()
         WHERE id_sincronizacion = ?`,
        [filas.length, nuevas, idSincronizacion],
      );

      this.logger.log(`Casilla SUNAFIL sincronizada (empresa ${idEmpresa}): ${filas.length} leídas, ${nuevas} nuevas.`);
      return { leidas: filas.length, nuevas, id_sincronizacion: idSincronizacion };
    } catch (error: any) {
      // El mensaje se guarda para revisión manual: sin esto, el usuario ve una
      // bandeja vacía sin saber si es que no hay nada o es que la lectura falló.
      await this.dataSource.query(
        `UPDATE sunafil_sincronizacion SET estado = 'ERROR', mensaje_error = ?, fecha_fin = NOW() WHERE id_sincronizacion = ?`,
        [String(error?.message || 'Error desconocido').slice(0, 2000), idSincronizacion],
      );
      throw new BadRequestException(error?.message || 'No se pudo leer la casilla electrónica de SUNAFIL');
    }
  }

  /**
   * Inserta solo lo que todavía no existe, en una sola transacción.
   *
   * Se consultan primero los hashes ya guardados en vez de usar
   * `INSERT ... ON DUPLICATE KEY UPDATE`: así el conteo de "nuevas" es exacto
   * (con ON DUPLICATE, `affectedRows` mezcla inserciones y actualizaciones) y
   * queda imposible pisar por accidente el `estado_gestion`/`observaciones` que
   * ya cargó el encargado sobre una notificación vieja.
   */
  private async guardarNotificaciones(idEmpresa: number, filas: FilaCasillaSunafil[], userId: number): Promise<number> {
    if (filas.length === 0) return 0;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const existentes: Array<{ hash_dedupe: string }> = await qr.query(
        `SELECT hash_dedupe FROM sunafil_notificacion WHERE id_empresa = ?`,
        [idEmpresa],
      );
      const yaGuardados = new Set(existentes.map((e) => e.hash_dedupe));

      const porInsertar = filas
        .map((fila) => ({ fila, hash: this.calcularHash(fila) }))
        .filter(({ hash }) => !yaGuardados.has(hash));

      // Dos filas de la MISMA bandeja pueden colisionar entre sí (portal con dos
      // renglones idénticos); sin esto, el INSERT múltiple reventaría contra el
      // UNIQUE y tumbaría toda la sincronización.
      const vistosEnEstaTanda = new Set<string>();
      const unicos = porInsertar.filter(({ hash }) => {
        if (vistosEnEstaTanda.has(hash)) return false;
        vistosEnEstaTanda.add(hash);
        return true;
      });

      if (unicos.length > 0) {
        const values = unicos.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const params: any[] = [];
        for (const { fila, hash } of unicos) {
          params.push(
            idEmpresa,
            this.recortar(fila.codigo_notificacion, 100),
            this.recortar(fila.tipo_documento, 255),
            this.recortar(fila.asunto, 500),
            this.recortar(fila.numero_expediente, 100),
            this.recortar(fila.remitente, 255),
            this.parsearFecha(fila.fecha_deposito),
            fila.leido_en_sunafil ? 1 : 0,
            JSON.stringify(fila.datos_crudos),
            hash,
            userId,
          );
        }
        await qr.query(
          `INSERT INTO sunafil_notificacion
             (id_empresa, codigo_notificacion, tipo_documento, asunto, numero_expediente, remitente,
              fecha_deposito, leido_en_sunafil, datos_crudos_json, hash_dedupe, id_usuario_crea)
           VALUES ${values}`,
          params,
        );
      }

      await qr.commitTransaction();
      return unicos.length;
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // -------------------------------------------------------------- GESTIÓN

  async gestionar(idEmpresa: number, id: number, dto: GestionarNotificacionSunafilDto, userId: number) {
    const anterior = await this.obtenerNotificacion(idEmpresa, id);

    const observaciones = dto.observaciones?.trim() || null;
    const resultado = await this.dataSource.query(
      `UPDATE sunafil_notificacion
       SET estado_gestion = ?, observaciones = ?, id_usuario_mod = ?
       WHERE id_notificacion = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [dto.estado_gestion, observaciones, userId, id, idEmpresa],
    );
    if (!resultado?.affectedRows) throw new NotFoundException('Notificación no encontrada');

    await this.auditoriaService.registrar(
      'sunafil_notificacion', id, 'ACTUALIZAR', userId,
      { estado_gestion: anterior.estado_gestion, observaciones: anterior.observaciones },
      { estado_gestion: dto.estado_gestion, observaciones },
    );

    return { message: 'Notificación actualizada' };
  }

  async obtenerNotificacion(idEmpresa: number, id: number) {
    // El WHERE incluye id_empresa: sin eso, cambiar el id en la URL dejaría leer
    // notificaciones de otra empresa cliente (IDOR).
    const [row] = await this.dataSource.query(
      `SELECT * FROM sunafil_notificacion
       WHERE id_notificacion = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [id, idEmpresa],
    );
    if (!row) throw new NotFoundException('Notificación no encontrada');
    return row;
  }

  // -------------------------------------------------------------- AUXILIARES

  private async obtenerEmpresaConCredenciales(idEmpresa: number) {
    const [row] = await this.dataSource.query(
      `SELECT id_empresa, ruc, razon_social, sunat_sol_usuario, sunat_sol_password
       FROM empresa WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!row) throw new NotFoundException('Empresa no encontrada');
    if (!row.sunat_sol_usuario || !row.sunat_sol_password) {
      // La casilla de EMPLEADOR de SUNAFIL no tiene clave propia: entra con la
      // Clave SOL de SUNAT vía OAuth2 (verificado en vivo, ver el client).
      throw new BadRequestException(
        `La empresa ${row.razon_social} no tiene Clave SOL guardada. `
        + `La casilla de SUNAFIL se abre con la misma Clave SOL de SUNAT — cárgala en Empresas → Credenciales SUNAT.`,
      );
    }
    return {
      ruc: row.ruc as string,
      razonSocial: row.razon_social as string,
      solUsuario: this.credencialesCrypto.descifrar(row.sunat_sol_usuario),
      solPassword: this.credencialesCrypto.descifrar(row.sunat_sol_password),
    };
  }

  /**
   * Identidad de una notificación. Se prefiere el código que da SUNAFIL; si la
   * bandeja no trae uno, se cae a la combinación de campos visibles. Nunca se
   * incluye `leido_en_sunafil`: ese valor cambia con el tiempo y haría que la
   * misma notificación se duplique al marcarse leída.
   */
  private calcularHash(fila: FilaCasillaSunafil): string {
    const base = fila.codigo_notificacion
      ? `cod:${fila.codigo_notificacion}`
      : [fila.fecha_deposito, fila.numero_expediente, fila.tipo_documento, fila.asunto].map((v) => v || '').join('|');
    return createHash('sha256').update(base).digest('hex');
  }

  /**
   * SUNAFIL muestra las fechas en formato peruano (`dd/mm/aaaa`, a veces con
   * hora). `new Date('15/08/2026')` da `Invalid Date` en Node, así que se parsea
   * a mano a `YYYY-MM-DD HH:mm:ss`. Si no se puede interpretar se guarda NULL —
   * el texto original igual queda en `datos_crudos_json`, nunca se pierde.
   */
  private parsearFecha(texto: string | null): string | null {
    if (!texto) return null;
    const m = texto.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    const [, d, mes, a, hh, mm, ss] = m;
    const p = (v: string | undefined, def = '00') => (v ? v.padStart(2, '0') : def);
    return `${a}-${p(mes)}-${p(d)} ${p(hh)}:${p(mm)}:${p(ss)}`;
  }

  private recortar(valor: string | null, max: number): string | null {
    if (!valor) return null;
    const limpio = valor.trim();
    return limpio ? limpio.slice(0, max) : null;
  }
}

import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { promises as fs } from 'fs';
import { join } from 'path';
import { AuditoriaService } from '@app/common';
import { CredencialesCryptoService } from '@app/security';
import { SunatPleClient, LibroPlePresentado } from './sunat-ple.client';
import { SincronizarPleDto } from './ple.dto';

// ⚠️ NUNCA dentro de `uploads/` — esa carpeta se sirve pública sin login vía
// `app.useStaticAssets` en main.ts. La constancia lleva RUC y razón social del
// contribuyente, así que va en storage-privado y solo se entrega a través de
// `descargarConstancia()`, detrás de JwtAuthGuard + PermissionsGuard + el WHERE
// id_empresa. Mismo criterio que ya usa sire.service.ts para los ZIP.
const CARPETA_CONSTANCIAS = join(process.cwd(), 'storage-privado', 'ple-constancias');

// PLE arrancó en 2011 (primeros obligados). Antes de ese año SUNAT no tiene nada que
// devolver, y cada año consultado cuesta un viaje más contra el portal.
const ANIO_MINIMO_PLE = 2011;

// Los dos únicos libros de PLE que SIRE llegó a reemplazar. El resto (diario, mayor,
// inventarios, activos fijos) sigue yendo por PLE hasta hoy y no tiene equivalente
// SIRE — por eso el mapeo devuelve null y no fuerza una equivalencia falsa.
const EQUIVALENCIA_SIRE: Record<string, 'RVIE' | 'RCE'> = {
  '080000': 'RCE', // Registro de Compras
  '140000': 'RVIE', // Registro de Ventas e Ingresos
};

/**
 * Libros presentados por PLE — los periodos ANTERIORES a que cada empresa entrara a
 * SIRE. Ver el encabezado de `sunat-ple.client.ts` para por qué esto es scraping del
 * portal y no puede ser una API.
 *
 * Se apoya en las MISMAS credenciales SOL por empresa que ya usa el módulo SIRE
 * (`empresa.sunat_sol_usuario` / `sunat_sol_password`, cifradas en app), pero NO
 * necesita el client_id/client_secret de la API: el portal se abre con Clave SOL a
 * secas. Eso importa porque no todas las ~170 empresas tienen las credenciales de API
 * generadas, y sin embargo todas tienen historial PLE que recuperar.
 */
@Injectable()
export class PleService {
  private readonly logger = new Logger(PleService.name);

  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private credencialesCrypto: CredencialesCryptoService,
    private pleClient: SunatPleClient,
  ) {}

  private async obtenerCredenciales(idEmpresa: number) {
    const [empresa] = await this.dataSource.query(
      `SELECT id_empresa, ruc, razon_social, sunat_sol_usuario, sunat_sol_password
       FROM empresa WHERE id_empresa = ? AND estado_cliente = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!empresa) throw new NotFoundException('Empresa no encontrada');
    if (!empresa.sunat_sol_usuario || !empresa.sunat_sol_password) {
      throw new BadRequestException('Falta configurar usuario/clave SOL de esta empresa (Empresas → Credenciales SUNAT)');
    }
    // .trim() por el mismo motivo que en sire.service.ts: las credenciales guardadas
    // antes de que el guardado limpiara espacios siguen en BD con el salto de línea
    // pegado del copy-paste, y eso solo se manifiesta como un login rechazado.
    return {
      ruc: String(empresa.ruc).trim(),
      razonSocial: empresa.razon_social,
      usuarioSol: this.credencialesCrypto.descifrar(empresa.sunat_sol_usuario).trim(),
      claveSol: this.credencialesCrypto.descifrar(empresa.sunat_sol_password).trim(),
    };
  }

  /**
   * Trae de SUNAT el historial PLE completo de una empresa y lo guarda.
   *
   * ES LENTO A PROPÓSITO Y NO HAY VUELTA: SUNAT toma el RUC de la sesión (el parámetro
   * `numeroRuc` va fijo en "-1"), así que es una sesión de navegador POR EMPRESA, más
   * un viaje por año. Quien llame debe mostrar estado de carga y no encadenar las ~170
   * empresas en un request HTTP.
   */
  async sincronizar(dto: SincronizarPleDto, idUsuario: number) {
    const cred = await this.obtenerCredenciales(dto.id_empresa);
    const anioDesde = Math.max(dto.anio_desde ?? ANIO_MINIMO_PLE, ANIO_MINIMO_PLE);
    const anioHasta = dto.anio_hasta ?? new Date().getFullYear();
    if (anioDesde > anioHasta) throw new BadRequestException('El año inicial no puede ser mayor que el final');

    this.logger.log(`Sincronizando PLE de ${cred.razonSocial} (RUC ${cred.ruc}), ${anioDesde}-${anioHasta}`);
    const libros = await this.pleClient.listarLibros(cred.ruc, cred.usuarioSol, cred.claveSol, anioDesde, anioHasta);

    let nuevos = 0;
    for (const libro of libros) {
      const insertado = await this.guardarLibro(dto.id_empresa, libro, idUsuario);
      if (insertado) nuevos++;
    }

    const sireDesde = await this.deducirCorteSire(dto.id_empresa, libros, anioHasta);

    await this.auditoriaService.registrar('ple_libro_presentado', dto.id_empresa, 'CREAR', idUsuario, null, {
      id_empresa: dto.id_empresa, anio_desde: anioDesde, anio_hasta: anioHasta, encontrados: libros.length, nuevos,
    });

    return {
      encontrados: libros.length,
      nuevos,
      ya_registrados: libros.length - nuevos,
      sire_desde_periodo: sireDesde,
      rango: { anio_desde: anioDesde, anio_hasta: anioHasta },
    };
  }

  /**
   * Devuelve true si la fila era nueva. El INSERT ... ON DUPLICATE KEY es lo que hace
   * que la sincronización se pueda repetir sin duplicar: la clave única es la
   * constancia (empresa + numArchivoRes + annArchivoRes), no el periodo, porque una
   * rectificatoria del mismo periodo genera OTRA constancia y las dos son válidas.
   */
  private async guardarLibro(idEmpresa: number, libro: LibroPlePresentado, idUsuario: number): Promise<boolean> {
    const periodo = `${libro.perAnioPreslib}${String(libro.perMesPreslib).padStart(2, '0')}`;
    const codLibro = String(libro.codLibro || '').trim();
    const resultado: any = await this.dataSource.query(
      `INSERT INTO ple_libro_presentado
         (id_empresa, periodo, cod_libro, desc_libro, tipo_libro, fecha_presentacion, fuera_de_plazo,
          num_archivo_res, ann_archivo_res, cod_oportunidad, ind_operacion, ind_moneda, ind_simplificado,
          respuesta_cruda_json, estado_registro, id_usuario_crea)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)
       ON DUPLICATE KEY UPDATE fecha_sincronizacion = NOW()`,
      [
        idEmpresa, periodo, codLibro, libro.codDescLibro || '', EQUIVALENCIA_SIRE[codLibro] ?? null,
        libro.fecPresentacion, libro.indAtraso === '1' ? 1 : 0,
        String(libro.numArchivoRes), String(libro.annArchivoRes),
        (libro.codOportunidad ?? '').trim() || null, (libro.indOperacion ?? '').trim() || null,
        (libro.indMoneda ?? '').trim() || null, (libro.indSimplificado ?? '').trim() || null,
        JSON.stringify(libro), idUsuario,
      ],
    );
    // MySQL devuelve affectedRows=1 en un INSERT nuevo y 2 cuando el ON DUPLICATE
    // actualizó una fila existente.
    return Number(resultado?.affectedRows) === 1;
  }

  /**
   * Deduce desde qué periodo la empresa está en SIRE y lo guarda en `empresa`.
   *
   * La regla es el periodo SIGUIENTE al último libro que SUNAT devolvió por PLE: si el
   * último PLE es 2023-09, desde 2023-10 esa empresa declara por SIRE. Sale de los
   * datos y no del cronograma teórico de incorporación, que fue por olas y no dice
   * nada sobre una empresa concreta.
   *
   * SOLO se escribe si la sincronización llegó hasta el año en curso. Sincronizar
   * "2017 a 2019" también termina con un último libro en 2019, pero eso no significa
   * que la empresa entró a SIRE en 2020 — significa que no se preguntó más allá.
   */
  private async deducirCorteSire(idEmpresa: number, libros: LibroPlePresentado[], anioHasta: number): Promise<string | null> {
    if (!libros.length || anioHasta < new Date().getFullYear()) return null;

    const periodos = libros.map((l) => `${l.perAnioPreslib}${String(l.perMesPreslib).padStart(2, '0')}`).sort();
    const ultimo = periodos[periodos.length - 1];
    const anio = Number(ultimo.slice(0, 4));
    const mes = Number(ultimo.slice(4, 6));
    const siguiente = mes === 12 ? `${anio + 1}01` : `${anio}${String(mes + 1).padStart(2, '0')}`;

    await this.dataSource.query(`UPDATE empresa SET sire_desde_periodo = ? WHERE id_empresa = ?`, [siguiente, idEmpresa]);
    this.logger.log(`Empresa ${idEmpresa}: último PLE ${ultimo} → sire_desde_periodo = ${siguiente}`);
    return siguiente;
  }

  async findAll(idEmpresa: number, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const offset = (page - 1) * limit;

    const where: string[] = ['id_empresa = ?', `estado_registro = 'ACTIVO'`];
    const params: any[] = [idEmpresa];
    if (query.periodo) { where.push('periodo = ?'); params.push(query.periodo); }
    if (query.cod_libro) { where.push('cod_libro = ?'); params.push(query.cod_libro); }
    if (query.solo_fuera_plazo === 'true') where.push('fuera_de_plazo = 1');
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT id_ple, periodo, cod_libro, desc_libro, tipo_libro, fecha_presentacion, fuera_de_plazo,
                num_archivo_res, ann_archivo_res, constancia_ruta, fecha_sincronizacion
         FROM ple_libro_presentado ${whereSql}
         ORDER BY periodo DESC, cod_libro ASC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total FROM ple_libro_presentado ${whereSql}`, params),
    ]);
    return { data, meta: { total: Number(total), page, limit } };
  }

  // WHERE con id_empresa: sin esto cualquiera con acceso a una empresa podría bajarse
  // la constancia de otra cambiando el id en la URL.
  private async obtenerLibro(idEmpresa: number, id: number) {
    const [row] = await this.dataSource.query(
      `SELECT * FROM ple_libro_presentado WHERE id_ple = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [id, idEmpresa],
    );
    if (!row) throw new NotFoundException('Libro PLE no encontrado');
    return row;
  }

  /**
   * Entrega el PDF de la constancia. La primera vez abre una sesión SOL y la baja de
   * SUNAT (~20 s); de ahí en adelante sale del disco. Sin ese caché, cada click
   * significaría un login contra la cuenta real del cliente.
   */
  async descargarConstancia(idEmpresa: number, id: number, res: Response, idUsuario: number) {
    const libro = await this.obtenerLibro(idEmpresa, id);
    const nombre = `constancia-ple-${libro.periodo}-${libro.cod_libro}-${libro.num_archivo_res}.pdf`;
    let rutaAbsoluta = libro.constancia_ruta ? join(process.cwd(), 'storage-privado', libro.constancia_ruta) : null;

    const enDisco = rutaAbsoluta ? await fs.access(rutaAbsoluta).then(() => true).catch(() => false) : false;
    if (!enDisco) {
      const cred = await this.obtenerCredenciales(idEmpresa);
      const pdf = await this.pleClient.descargarConstancia(
        cred.ruc, cred.usuarioSol, cred.claveSol, libro.num_archivo_res, libro.ann_archivo_res,
      );
      await fs.mkdir(CARPETA_CONSTANCIAS, { recursive: true });
      rutaAbsoluta = join(CARPETA_CONSTANCIAS, nombre);
      await fs.writeFile(rutaAbsoluta, pdf);
      const rutaRelativa = `ple-constancias/${nombre}`;
      await this.dataSource.query(
        `UPDATE ple_libro_presentado SET constancia_ruta = ? WHERE id_ple = ? AND id_empresa = ?`,
        [rutaRelativa, id, idEmpresa],
      );
      await this.auditoriaService.registrar('ple_libro_presentado', id, 'ACTUALIZAR', idUsuario, null, { constancia_ruta: rutaRelativa });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.sendFile(rutaAbsoluta!);
  }
}

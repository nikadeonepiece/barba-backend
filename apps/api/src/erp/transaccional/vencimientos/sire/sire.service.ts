import { Injectable, BadRequestException, NotFoundException, HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { promises as fs } from 'fs';
import { join } from 'path';
import { AuditoriaService } from '@app/common';
import { CredencialesCryptoService } from '../../../comun/credenciales-crypto.service';
import { GenerarDescargaSireDto } from './sire.dto';
import { parsearArchivoSire } from './sire-parser.util';

const COLS_ORDER_ALLOWED = ['id_descarga', 'periodo', 'fecha_generacion'];
// ⚠️ NUNCA dentro de `uploads/` — esa carpeta se sirve pública sin login vía
// `app.useStaticAssets` en main.ts. Los ZIP de SIRE traen datos tributarios reales del
// cliente (RUC de terceros, montos), así que van en una carpeta aparte que el servidor
// estático no toca — solo se sirven a través de `descargarArchivoGuardado()`, detrás
// de JwtAuthGuard + PermissionsGuard + el WHERE id_empresa (ver `obtenerDescarga`).
const CARPETA_DESCARGAS = join(process.cwd(), 'storage-privado', 'sire');

// ESTRUCTURA SUNAT — SIRE (RVIE/RCE), portado desde YUNTA-ERP (donde ya está probado
// contra SUNAT real, ver comentarios de cada método) y adaptado a MULTI-EMPRESA: acá
// no hay una sola "empresa emisora" dueña del sistema, sino ~170 empresas CLIENTE del
// estudio — cada llamada exige `id_empresa` y saca las credenciales de la fila de esa
// empresa en `empresa` (columnas `sunat_sol_usuario`/`sunat_sol_password`/
// `sunat_api_client_id`/`sunat_api_client_secret`, ya cifradas en app con
// CredencialesCryptoService — el mismo cifrado que ya usa `empresas.service.ts` para
// las credenciales SOL). El login real de SUNAT para esta API es OAuth2 "password
// grant" combinando usuario/clave SOL CON client_id/secret (no solo uno de los dos).
// El token nunca se persiste en BD — se pide de nuevo en cada operación (vida corta,
// ~1h); cachearlo es una optimización para después, no necesaria para las pruebas
// iniciales.
//
// A diferencia de YUNTA-ERP, este módulo NO concilia contra tablas de compras/ventas
// propias — el estudio no lleva la contabilidad operativa de sus clientes, solo
// vencimientos, así que `verDetalle` devuelve la lista tal cual la entrega SUNAT.
//
// ⚠️ Los endpoints/scope exactos de la API SIRE los define SUNAT y pueden cambiar de
// nombre entre versiones (sobre todo el segmento de RCE, menos documentado que RVIE)
// — quedan como variables de entorno con un valor por defecto para no tener que tocar
// código si SUNAT ajusta la URL. Verificar contra la documentación vigente de SUNAT
// antes de usar en producción.
@Injectable()
export class SireService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private configService: ConfigService,
    private auditoriaService: AuditoriaService,
    private credencialesCrypto: CredencialesCryptoService,
  ) {}

  private async obtenerEmpresa(idEmpresa: number) {
    const [empresa] = await this.dataSource.query(
      `SELECT id_empresa, ruc, sunat_sol_usuario, sunat_sol_password, sunat_api_client_id, sunat_api_client_secret
       FROM empresa WHERE id_empresa = ? AND estado_cliente = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!empresa) throw new NotFoundException('Empresa no encontrada');
    return empresa;
  }

  private async obtenerCredenciales(idEmpresa: number) {
    const empresa = await this.obtenerEmpresa(idEmpresa);
    if (!empresa.sunat_sol_usuario || !empresa.sunat_sol_password) {
      throw new BadRequestException('Falta configurar usuario/clave SOL de esta empresa (Empresas → Credenciales SUNAT)');
    }
    if (!empresa.sunat_api_client_id || !empresa.sunat_api_client_secret) {
      throw new BadRequestException('Falta configurar client_id/client_secret de la API SUNAT de esta empresa (Empresas → Credenciales SUNAT)');
    }
    return {
      ruc: empresa.ruc as string,
      usuarioSol: this.credencialesCrypto.descifrar(empresa.sunat_sol_usuario),
      claveSol: this.credencialesCrypto.descifrar(empresa.sunat_sol_password),
      clientId: this.credencialesCrypto.descifrar(empresa.sunat_api_client_id),
      clientSecret: this.credencialesCrypto.descifrar(empresa.sunat_api_client_secret),
    };
  }

  private async obtenerToken(idEmpresa: number): Promise<string> {
    const cred = await this.obtenerCredenciales(idEmpresa);
    const oauthUrl = (this.configService.get<string>('SUNAT_SIRE_OAUTH_URL')
      || 'https://api-seguridad.sunat.gob.pe/v1/clientessol/{client_id}/oauth2/token')
      .replace('{client_id}', cred.clientId);
    const scope = this.configService.get<string>('SUNAT_SIRE_SCOPE') || 'https://api-sire.sunat.gob.pe';

    const body = new URLSearchParams({
      grant_type: 'password',
      scope,
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      username: `${cred.ruc}${cred.usuarioSol}`,
      password: cred.claveSol,
    });

    const resp = await fetch(oauthUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data: any = await resp.json().catch(() => null);
    if (!resp.ok || !data?.access_token) {
      throw new HttpException(
        `SUNAT rechazó la autenticación (${resp.status}): ${data?.error_description || data?.error || 'sin detalle'}`,
        resp.status >= 400 && resp.status < 500 ? 400 : 502,
      );
    }
    return data.access_token;
  }

  // Headers Accept/Content-Type explícitos son OBLIGATORIOS (confirmado en vivo en
  // YUNTA-ERP): sin ellos SUNAT devuelve un 500 genérico "Request failed" en vez de
  // procesar la petición y dar el error real de negocio.
  private headersSunat(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  private async fetchSunat(url: string, token: string) {
    const resp = await fetch(url, { headers: this.headersSunat(token) });
    const data: any = await resp.json().catch(() => null);
    if (!resp.ok) {
      const detalle = data?.errors?.[0]?.msg || data?.msg || data?.error_description || data?.message || 'sin detalle';
      throw new HttpException(
        `SUNAT respondió con error (${resp.status}): ${detalle}`,
        resp.status >= 400 && resp.status < 500 ? 400 : 502,
      );
    }
    return data;
  }

  // Prueba de conexión: solo confirma que las credenciales guardadas de esa empresa
  // obtienen un token válido de SUNAT — no descarga ningún dato todavía.
  async probarConexion(idEmpresa: number) {
    const token = await this.obtenerToken(idEmpresa);
    return { conectado: true, token_obtenido: !!token, fecha: new Date().toISOString() };
  }

  // -------------------------------------------------------------------
  // Flujo completo con ticket (RVIE y RCE): generar → consultar estado →
  // descargar el archivo real cuando SUNAT terminó de procesarlo.
  // -------------------------------------------------------------------

  private construirUrl(plantillaEnv: string, defecto: string, valores: Record<string, string>) {
    const baseUrl = this.configService.get<string>('SUNAT_SIRE_BASE_URL') || 'https://api-sire.sunat.gob.pe';
    let path = this.configService.get<string>(plantillaEnv) || defecto;
    for (const [clave, valor] of Object.entries(valores)) path = path.replaceAll(`{${clave}}`, valor);
    return `${baseUrl}${path}`;
  }

  async findAll(idEmpresa: number, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const offset = (page - 1) * limit;

    const where: string[] = [`id_empresa = ?`, `estado_registro = 'ACTIVO'`];
    const params: any[] = [idEmpresa];
    if (query.tipo_libro) { where.push('tipo_libro = ?'); params.push(query.tipo_libro); }
    if (query.periodo) { where.push('periodo = ?'); params.push(query.periodo); }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort) ? query.sort : 'id_descarga';
    const sortDir = query.dir === 'ASC' ? 'ASC' : 'DESC';

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT id_descarga, tipo_libro, periodo, ticket, estado_ticket, archivo_ruta, fecha_generacion, fecha_descarga
         FROM sire_descarga ${whereSql} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total FROM sire_descarga ${whereSql}`, params),
    ]);
    return { data, meta: { total: Number(total), page, limit } };
  }

  // WHERE incluye id_empresa — sin esto, cualquier usuario con acceso a otra empresa
  // podría leer/operar descargas SIRE de una empresa ajena cambiando el id en la URL.
  private async obtenerDescarga(idEmpresa: number, id: number) {
    const [row] = await this.dataSource.query(
      `SELECT * FROM sire_descarga WHERE id_descarga = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [id, idEmpresa],
    );
    if (!row) throw new NotFoundException('Descarga no encontrada');
    return row;
  }

  // Genera el ticket de la propuesta/preliminar en SUNAT y crea el registro de
  // historial. RVIE y RCE usan endpoints DISTINTOS — no comparten el mismo patrón de
  // URL (a diferencia de consultarEstado/traerArchivo, que sí son compartidos bajo
  // "rvierce"). Confirmado en YUNTA-ERP contra el manual oficial de Compras (sección
  // 5.40 "exportar preliminar de registro de compras"): RCE no tiene equivalente a
  // "propuesta/web/propuesta/.../exportapropuesta" (por eso esa ruta daba 500 de
  // nginx — no existe para RCE) — usa "preliminar/web/registroslibros/.../
  // exportareportepreliminar" y exige además el parámetro codOrigenEnvio=2 ("Servicio
  // web"), que RVIE no pide.
  async generarTicket(dto: GenerarDescargaSireDto, idUsuario: number) {
    await this.obtenerEmpresa(dto.id_empresa); // valida que la empresa exista antes de gastar un llamado a SUNAT
    const token = await this.obtenerToken(dto.id_empresa);
    const tipoLibro = dto.tipo_libro.toLowerCase(); // 'rvie' | 'rce'
    const url = tipoLibro === 'rce'
      ? this.construirUrl(
          'SUNAT_SIRE_PATH_TICKET_RCE',
          '/v1/contribuyente/migeigv/libros/rce/preliminar/web/registroslibros/{periodo}/exportareportepreliminar?codTipoArchivo=0&codOrigenEnvio=2',
          { periodo: dto.periodo },
        )
      // codTipoArchivo=0 confirmado contra el endpoint real de SUNAT — sin este
      // parámetro SUNAT responde 422 "El campo 'codTipoArchivo' es nulo o vacío".
      // 0 = tipo de archivo por defecto.
      : this.construirUrl(
          'SUNAT_SIRE_PATH_TICKET',
          '/v1/contribuyente/migeigv/libros/{tipoLibro}/propuesta/web/propuesta/{periodo}/exportapropuesta?codTipoArchivo=0',
          { tipoLibro, periodo: dto.periodo },
        );
    const respuesta = await this.fetchSunat(url, token);
    const ticket = respuesta?.numTicket || respuesta?.ticket || null;
    if (!ticket) {
      throw new HttpException('SUNAT no devolvió un número de ticket — revisar SUNAT_SIRE_PATH_TICKET y la respuesta cruda', 502);
    }

    const res: any = await this.dataSource.query(
      `INSERT INTO sire_descarga (id_empresa, tipo_libro, periodo, ticket, estado_ticket, respuesta_cruda_json, estado_registro, id_usuario_crea)
       VALUES (?, ?, ?, ?, 'GENERADO', ?, 'ACTIVO', ?)`,
      [dto.id_empresa, dto.tipo_libro, dto.periodo, ticket, JSON.stringify(respuesta), idUsuario],
    );
    const idNuevo = Number(res.insertId);
    await this.auditoriaService.registrar('sire_descarga', idNuevo, 'CREAR', idUsuario, null, { id_empresa: dto.id_empresa, tipo_libro: dto.tipo_libro, periodo: dto.periodo, ticket });
    return { id: idNuevo, ticket };
  }

  // Pregunta a SUNAT si el ticket ya terminó de procesarse. Confirmado en YUNTA-ERP
  // contra el manual oficial "Manual de servicios Web Api Ventas v22_Parte II.pdf",
  // sección 5.16, Y contra una respuesta real de SUNAT: el endpoint es compartido
  // para RVIE y RCE bajo el segmento fijo "rvierce" (no {tipoLibro}), y exige
  // page/perPage además de perIni/perFin. OJO — dos cosas que el manual describe
  // distinto a como llega en la práctica:
  //  1. `codEstadoEnvio` terminado real fue "06" ("Terminado"), no "05" como sugiere
  //     el Anexo III (esa tabla del PDF vino con el formato roto al extraer texto) —
  //     por eso se valida por texto (`desEstadoEnvio`), no solo por código.
  //  2. `archivoReporte` NO viene anidado dentro de `detalleTicket` — es un array
  //     HERMANO de detalleTicket, al mismo nivel dentro de cada elemento de `registros`.
  async consultarEstado(idEmpresa: number, id: number) {
    const descarga = await this.obtenerDescarga(idEmpresa, id);
    const token = await this.obtenerToken(idEmpresa);
    const url = this.construirUrl(
      'SUNAT_SIRE_PATH_ESTADO',
      '/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets?perIni={periodo}&perFin={periodo}&page=1&perPage=20&numTicket={ticket}',
      { periodo: descarga.periodo, ticket: descarga.ticket || '' },
    );
    const respuesta = await this.fetchSunat(url, token);

    const registros = respuesta?.registros || [];
    const match = Array.isArray(registros)
      ? registros.find((r: any) => String(r?.detalleTicket?.numTicket) === String(descarga.ticket))
      : null;
    const detalle = match?.detalleTicket;

    const descripcionEstado = String(detalle?.desEstadoEnvio || '').toUpperCase();
    let estadoTicket: string = descarga.estado_ticket;
    if (descripcionEstado.includes('TERMINADO') || descripcionEstado.includes('CONCLUIDO')) estadoTicket = 'TERMINADO';
    else if (descripcionEstado.includes('ERROR')) estadoTicket = 'ERROR';
    else if (detalle?.codEstadoEnvio) estadoTicket = 'EN_PROCESO';

    const archivoReporte = match?.archivoReporte?.[0];
    const nombreArchivo = archivoReporte?.nomArchivoReporte || detalle?.nomArchivoReporte || null;
    const codTipoArchivoReporte = archivoReporte?.codTipoAchivoReporte ?? null;
    // codProceso viene HERMANO de detalleTicket/archivoReporte dentro de cada
    // elemento de `registros` (ej. "10" = "Generar archivo exportar propuesta").
    const codProceso = match?.codProceso ?? null;

    await this.dataSource.query(
      `UPDATE sire_descarga SET estado_ticket = ?, nombre_archivo_sunat = COALESCE(?, nombre_archivo_sunat),
              cod_tipo_archivo_reporte = COALESCE(?, cod_tipo_archivo_reporte),
              cod_proceso = COALESCE(?, cod_proceso), respuesta_cruda_json = ?
       WHERE id_descarga = ? AND id_empresa = ?`,
      [estadoTicket, nombreArchivo, codTipoArchivoReporte, codProceso, JSON.stringify(respuesta), id, idEmpresa],
    );
    return { id, estado_ticket: estadoTicket, nombre_archivo_sunat: nombreArchivo };
  }

  // Una vez TERMINADO, trae el archivo real de SUNAT y lo guarda en disco. Corregido
  // en YUNTA-ERP contra el manual oficial de Compras (RCE), sección 5.32 "Servicio
  // Web Api descargar archivo": el historial de cambios del propio manual (fila 8,
  // versión V24, 10/01/2025) documenta que SUNAT MODIFICÓ este endpoint agregando 3
  // parámetros obligatorios nuevos — perTributario, codProceso y numTicket — y quitó
  // codLibro de la firma. Esto explica el 422 "El archivo solicitado no existe" (cod
  // 2244) que daba siempre la implementación anterior: llamábamos a una versión
  // desactualizada del endpoint, sin los 3 parámetros que SUNAT ahora exige para
  // ubicar el archivo exacto.
  async traerArchivo(idEmpresa: number, id: number, idUsuario: number) {
    const descarga = await this.obtenerDescarga(idEmpresa, id);
    if (descarga.estado_ticket !== 'TERMINADO') {
      throw new BadRequestException('El ticket todavía no está TERMINADO — consulta el estado primero');
    }
    if (!descarga.nombre_archivo_sunat) {
      throw new BadRequestException('SUNAT no informó un nombre de archivo para este ticket');
    }
    if (!descarga.cod_proceso) {
      throw new BadRequestException('Falta codProceso — vuelve a "Consultar estado" para obtenerlo antes de traer el archivo');
    }

    const token = await this.obtenerToken(idEmpresa);
    const url = this.construirUrl(
      'SUNAT_SIRE_PATH_DESCARGA',
      '/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte'
      + '?nomArchivoReporte={nombreArchivo}&codTipoArchivoReporte={codTipoArchivoReporte}'
      + '&perTributario={perTributario}&codProceso={codProceso}&numTicket={numTicket}',
      {
        nombreArchivo: encodeURIComponent(descarga.nombre_archivo_sunat),
        codTipoArchivoReporte: descarga.cod_tipo_archivo_reporte ?? 'null',
        perTributario: descarga.periodo,
        codProceso: descarga.cod_proceso,
        numTicket: descarga.ticket,
      },
    );

    const resp = await fetch(url, { headers: this.headersSunat(token) });
    if (!resp.ok) {
      const cuerpo: any = await resp.json().catch(() => null);
      const detalle = cuerpo?.errors?.[0]?.msg || cuerpo?.msg || 'sin detalle';
      throw new HttpException(`SUNAT rechazó la descarga del archivo (${resp.status}): ${detalle}`, resp.status >= 400 && resp.status < 500 ? 400 : 502);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());

    await fs.mkdir(CARPETA_DESCARGAS, { recursive: true });
    const nombreLocal = `${descarga.tipo_libro}_${descarga.periodo}_${id}.zip`;
    await fs.writeFile(join(CARPETA_DESCARGAS, nombreLocal), buffer);

    const rutaRelativa = `sire/${nombreLocal}`;
    await this.dataSource.query(
      `UPDATE sire_descarga SET archivo_ruta = ?, fecha_descarga = NOW() WHERE id_descarga = ? AND id_empresa = ?`,
      [rutaRelativa, id, idEmpresa],
    );
    await this.auditoriaService.registrar('sire_descarga', id, 'ACTUALIZAR', idUsuario, { archivo_ruta: descarga.archivo_ruta }, { archivo_ruta: rutaRelativa });
    return { id, archivo_ruta: rutaRelativa };
  }

  // Sirve el archivo ya guardado localmente — nunca por la ruta estática pública
  // /uploads/, porque estos archivos contienen datos tributarios de un cliente.
  async descargarArchivoGuardado(idEmpresa: number, id: number, res: Response) {
    const descarga = await this.obtenerDescarga(idEmpresa, id);
    if (!descarga.archivo_ruta) throw new BadRequestException('Este ticket aún no tiene un archivo descargado — usa "Traer archivo" primero');

    const rutaAbsoluta = join(process.cwd(), 'storage-privado', descarga.archivo_ruta);
    const buffer = await fs.readFile(rutaAbsoluta).catch(() => { throw new NotFoundException('El archivo ya no existe en disco'); });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${descarga.tipo_libro}_${descarga.periodo}.zip"`);
    res.send(buffer);
  }

  // Lee el ZIP ya guardado en disco y parsea el TXT de SUNAT (RCE/RVIE tienen layouts
  // de columna distintos, ver sire-parser.util.ts) — devuelve las filas paginadas tal
  // cual las entrega SUNAT, sin cruzarlas contra ninguna tabla propia del estudio (a
  // diferencia de YUNTA-ERP, Barba no lleva la contabilidad operativa del cliente).
  async verDetalle(idEmpresa: number, id: number, query: any) {
    const descarga = await this.obtenerDescarga(idEmpresa, id);
    if (!descarga.archivo_ruta) {
      throw new BadRequestException('Este ticket aún no tiene un archivo descargado — usa "Traer archivo" primero');
    }

    const rutaAbsoluta = join(process.cwd(), 'storage-privado', descarga.archivo_ruta);
    const buffer = await fs.readFile(rutaAbsoluta).catch(() => { throw new NotFoundException('El archivo ya no existe en disco'); });

    const todasLasFilas = await parsearArchivoSire(buffer, descarga.tipo_libro);

    const busqueda = String(query.search || '').trim().toUpperCase();
    const filtradas = busqueda
      ? todasLasFilas.filter((f) =>
          f.razon_social_tercero.toUpperCase().includes(busqueda)
          || f.ruc_tercero.includes(busqueda)
          || `${f.serie}-${f.numero}`.toUpperCase().includes(busqueda),
        )
      : todasLasFilas;

    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;

    const resumen = filtradas.reduce(
      (acc, f) => ({
        base_imponible: acc.base_imponible + f.base_imponible,
        igv: acc.igv + f.igv,
        total: acc.total + f.total,
      }),
      { base_imponible: 0, igv: 0, total: 0 },
    );

    return {
      data: filtradas.slice(offset, offset + limit),
      meta: { total: filtradas.length, page, limit },
      resumen,
    };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { promises as fs } from 'fs';
import { join } from 'path';
import { parsearArchivoSire } from '../../estudio-barba/vencimientos/sire/sire-parser.util';
import { resolverEmpresaDelUsuario } from '../scope-empresa';

/**
 * SIRE — lado CLIENTE (solo lectura).
 *
 * Espejo acotado de `vencimientos/sire`, que es la pantalla del ESTUDIO: allá el
 * contador elige una de las ~170 empresas en un `ng-select`, pide el ticket a SUNAT,
 * consulta el estado y trae el archivo. Acá el usuario ES una empresa, no elige
 * ninguna, y no habla con SUNAT en ningún momento.
 *
 * ── Por qué el portal no genera tickets ──
 *
 * Generar un ticket usa las credenciales SOL de la empresa guardadas en `empresa` y
 * consume cupo real en SUNAT: dos personas pidiendo el mismo periodo a la vez crean
 * dos tickets y el segundo suele volver con error. Además, cuando SUNAT rechaza la
 * autenticación el mensaje es de configuración ("regenerá el client_secret para el
 * servicio SIRE"), y quien puede resolver eso es el estudio, no el cliente. Por eso
 * este módulo no reusa `SireService`: no es que filtre mal (sí filtra por empresa) —
 * es que expone `generarTicket`/`traerArchivo`/`probarConexion`, y un service del
 * portal que los tenga a mano termina llamándolos. Lo único compartido es
 * `parsearArchivoSire`, que es una función pura sobre un buffer.
 *
 * ── Por qué solo se ven las descargas que YA tienen archivo ──
 *
 * Un ticket en GENERADO o EN_PROCESO todavía no tiene nada que mostrar: sin ZIP no hay
 * grilla ni descarga, y la fila solo serviría para que el cliente pregunte por qué los
 * botones no hacen nada. Es la misma regla que `ESTADOS_VISIBLES` en las planillas del
 * portal: el periodo aparece recién cuando el documento es definitivo. Un ticket en
 * ERROR tampoco se muestra — es un problema del estudio con SUNAT, no del cliente.
 */
const CONDICION_VISIBLE = `estado_registro = 'ACTIVO' AND estado_ticket = 'TERMINADO' AND archivo_ruta IS NOT NULL`;

@Injectable()
export class SireClienteService {
  constructor(@InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource) {}

  /**
   * Listado paginado de los registros SIRE de la propia empresa.
   *
   * `id_empresa` sale del token (nunca del query): sin eso, cambiar un número en la
   * URL mostraría las ventas y compras de otra empresa (IDOR).
   */
  async findAll(user: any, query: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const offset = (page - 1) * limit;

    const where: string[] = [CONDICION_VISIBLE, 'id_empresa = ?'];
    const params: any[] = [idEmpresa];

    if (query.tipo_libro) {
      where.push('tipo_libro = ?');
      params.push(query.tipo_libro);
    }
    // El periodo se guarda como 'AAAAMM' en un varchar(6), así que año y mes se
    // recortan con SUBSTRING en vez de compararse contra columnas propias.
    if (query.anio) {
      where.push('SUBSTRING(periodo, 1, 4) = ?');
      params.push(String(query.anio));
    }
    if (query.mes) {
      where.push('SUBSTRING(periodo, 5, 2) = ?');
      params.push(String(query.mes).padStart(2, '0'));
    }
    // El buscador de `app-table-pro` está oculto en esta pantalla (los filtros de
    // arriba cubren el caso), pero `useCrud` manda `search` igual si alguien lo
    // reactiva: se resuelve contra el periodo, que es lo único que el cliente conoce
    // de memoria. El nº de ticket es un dato interno del estudio.
    if (query.search) {
      where.push('periodo LIKE ?');
      params.push(`%${String(query.search).trim()}%`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    // Sin ORDER BY dinámico a propósito: en una lista de periodos el único orden útil
    // es el más reciente arriba, y no hay nada que el cliente quiera elegir.
    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT id_descarga, tipo_libro, periodo, fecha_descarga
         FROM sire_descarga
         ${whereSql}
         ORDER BY periodo DESC, tipo_libro ASC, id_descarga DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total FROM sire_descarga ${whereSql}`, params),
    ]);

    return { data, meta: { total: Number(total), page, limit } };
  }

  /**
   * Años que la empresa tiene disponibles — alimenta el filtro.
   *
   * Sale de la data y no de una constante con los últimos N años: así el combo no
   * ofrece años vacíos ni se queda corto cuando el estudio cargue un periodo viejo.
   */
  async anios(user: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);
    return this.dataSource.query(
      `SELECT DISTINCT SUBSTRING(periodo, 1, 4) AS anio
       FROM sire_descarga
       WHERE ${CONDICION_VISIBLE} AND id_empresa = ?
       ORDER BY anio DESC`,
      [idEmpresa],
    );
  }

  /**
   * Verificación de pertenencia, escrita una sola vez: todo lo que recibe un `:id`
   * pasa por acá antes de tocar el disco.
   *
   * Mismo mensaje para "no existe", "es de otra empresa" y "el estudio todavía no
   * trajo el archivo". Distinguirlos le diría al cliente qué ids existen y en qué
   * estado está el SIRE de un tercero.
   */
  private async descargaConScope(user: any, id: number) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const [row] = await this.dataSource.query(
      `SELECT id_descarga, tipo_libro, periodo, archivo_ruta, fecha_descarga
       FROM sire_descarga
       WHERE id_descarga = ? AND id_empresa = ? AND ${CONDICION_VISIBLE}`,
      [id, idEmpresa],
    );

    if (!row) throw new NotFoundException('Registro SIRE no encontrado');
    return row;
  }

  private async leerZip(descarga: any): Promise<Buffer> {
    // `archivo_ruta` es relativa y la escribió el propio backend al traer el archivo
    // de SUNAT. La carpeta es `storage-privado/`, NUNCA `uploads/`: esta última se
    // sirve estática y sin login desde main.ts, y un ZIP de SIRE trae RUC y montos de
    // terceros. La única puerta a estos archivos es este service, detrás del guard y
    // del WHERE por empresa.
    const rutaAbsoluta = join(process.cwd(), 'storage-privado', descarga.archivo_ruta);
    return fs.readFile(rutaAbsoluta).catch(() => {
      throw new NotFoundException(
        'El archivo ya no está disponible. Pedile al estudio que lo vuelva a descargar de SUNAT.',
      );
    });
  }

  /**
   * Los comprobantes del periodo, parseados del TXT que viene dentro del ZIP de SUNAT
   * (RVIE y RCE tienen layouts de columna distintos — ver `sire-parser.util.ts`).
   *
   * Se parsea en cada request en vez de guardar las filas en una tabla propia: son
   * datos de SUNAT, no del estudio, y una copia en BD sería una segunda fuente de
   * verdad que queda vieja el día que el estudio vuelva a bajar el periodo corregido.
   */
  async verDetalle(user: any, id: number, query: any) {
    const descarga = await this.descargaConScope(user, id);
    const buffer = await this.leerZip(descarga);

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

    // El resumen se calcula sobre las filas FILTRADAS, no sobre el total: si el
    // cliente busca un proveedor, lo que quiere saber es cuánto le compró a ESE
    // proveedor.
    //
    // Se redondea a centavos al cerrar la suma: sumar cientos de decimales en JS
    // arrastra el error del punto flotante (0.1 + 0.2), y sin esto el IGV de un
    // periodo real sale como 252.09000000000003. Igual no cuadraría con SUNAT al
    // céntimo si se mostrara crudo.
    const acumulado = filtradas.reduce(
      (acc, f) => ({
        base_imponible: acc.base_imponible + f.base_imponible,
        igv: acc.igv + f.igv,
        total: acc.total + f.total,
      }),
      { base_imponible: 0, igv: 0, total: 0 },
    );
    const aCentavos = (n: number) => Math.round(n * 100) / 100;

    return {
      data: filtradas.slice(offset, offset + limit),
      meta: { total: filtradas.length, page, limit },
      resumen: {
        base_imponible: aCentavos(acumulado.base_imponible),
        igv: aCentavos(acumulado.igv),
        total: aCentavos(acumulado.total),
      },
    };
  }

  /** El ZIP tal cual lo entregó SUNAT, para quien quiera abrirlo aparte. */
  async descargarArchivo(user: any, id: number, res: Response) {
    const descarga = await this.descargaConScope(user, id);
    const buffer = await this.leerZip(descarga);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${descarga.tipo_libro}_${descarga.periodo}.zip"`);
    res.send(buffer);
  }
}

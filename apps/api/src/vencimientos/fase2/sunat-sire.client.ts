import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';

export interface ConstanciaSire {
  declarado: boolean;
  fechaConstancia: string | null;
  urlConstancia: string | null;
}

export interface PropuestaFV0621 {
  factprorrata: number | null; // coeficiente de prorrata
  valorRCF: number | null; // reintegro del crédito fiscal
  valorCFE: number | null; // crédito fiscal especial
}

/**
 * FASE 2 — cliente de la API OFICIAL de SUNAT para SIRE (RVIE/RCE).
 *
 * Autenticación — endpoint verificado por investigación (no leído línea por línea
 * del manual, a diferencia de los dos métodos de abajo, que sí):
 *
 *   POST https://api-seguridad.sunat.gob.pe/v1/clientessol/{client_id}/oauth2/token/
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: grant_type=password&scope=https://api-sire.sunat.gob.pe
 *         &client_id={client_id}&client_secret={client_secret}
 *         &username={RUC}{usuarioSOL}&password={claveSOL}
 *
 * OJO — corrección de diseño: este flujo SÍ requiere la Clave SOL en cada
 * solicitud de token (grant_type=password, no client_credentials puro). El
 * client_id/client_secret identifican la aplicación, pero no reemplazan la
 * Clave SOL — solo evitan automatizar un login por navegador.
 *
 * `consultarFV0621` y `consultarConstancia` — extraídos con pdf-parse
 * DIRECTAMENTE del manual oficial "SIRE Compras Servicios Web API v22 Parte
 * III" (secciones 5.14 y 5.49), no por búsqueda web ni supuesto.
 */
@Injectable()
export class SunatSireClient {
  private readonly logger = new Logger(SunatSireClient.name);
  private static readonly TOKEN_URL_BASE = 'https://api-seguridad.sunat.gob.pe/v1/clientessol';
  private static readonly SCOPE = 'https://api-sire.sunat.gob.pe';
  private static readonly SIRE_BASE = 'https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros';

  async obtenerToken(ruc: string, clientId: string, clientSecret: string, solUsuario: string, solPassword: string): Promise<string> {
    const url = `${SunatSireClient.TOKEN_URL_BASE}/${clientId}/oauth2/token/`;
    const body = new URLSearchParams({
      grant_type: 'password',
      scope: SunatSireClient.SCOPE,
      client_id: clientId,
      client_secret: clientSecret,
      username: `${ruc}${solUsuario}`,
      password: solPassword,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const detalle = await response.text().catch(() => '');
      this.logger.error(`Token SUNAT SIRE falló (${response.status}) para RUC ${ruc}: ${detalle.slice(0, 300)}`);
      throw new Error(`No se pudo autenticar con SUNAT (SIRE): HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.access_token) throw new Error('SUNAT no devolvió access_token en la respuesta de autenticación');
    return data.access_token;
  }

  /**
   * Sección 5.14 del manual oficial, verbatim: PUT (no GET — confirmado en el
   * manual, aunque sea inusual para una consulta), sin body, todo por query string.
   * Devuelve los datos de prorrata/crédito fiscal que alimentan `saldo_favor`.
   */
  async consultarFV0621(token: string, periodoAnio: number, periodoMes: number): Promise<PropuestaFV0621> {
    const periodo = `${periodoAnio}${String(periodoMes).padStart(2, '0')}`;
    const url = `${SunatSireClient.SIRE_BASE}/rce/propuesta/web?periodoSeleccionado=${periodo}&tipoInfo=FV0621`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const detalle = await response.text().catch(() => '');
      throw new Error(`Consulta FV0621 falló: HTTP ${response.status} - ${detalle.slice(0, 300)}`);
    }

    const data = await response.json();
    const registro = Array.isArray(data?.registros) ? data.registros[0] : null;
    return {
      factprorrata: registro?.factprorrata ?? null,
      valorRCF: registro?.valorRCF ?? null,
      valorCFE: registro?.valorCFE ?? null,
    };
  }

  /**
   * Sección 5.49 del manual oficial, verbatim: GET, requiere el nombre/ruta
   * exacto del archivo (`nomConstanciaRecepcion`), NO solo el RUC y periodo.
   *
   * GAP QUE QUEDA ABIERTO (revisado también contra "SIRE Ventas Parte I",
   * texto real extraído con pdf-parse, no solo el de Compras):
   *   1. Antes de poder descargar la constancia, hay que llamar
   *      POST https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros/
   *      rvierce/gestionlibro/web/registroslibros/{perTributario}/registrapreliminar
   *      ("registrar preliminar", sección 5.9 del manual de Ventas) — esto
   *      dispara la generación del RVIE/RCE del periodo en el lado de SUNAT.
   *   2. Después de eso, en algún momento queda disponible un nombre de
   *      archivo con un patrón como "LE{RUC}{...}{periodo}{fechahora}.pdf"
   *      (visto en el ejemplo del manual), pero NO until confirmé de qué
   *      endpoint exacto sale ese nombre completo — "5.31 consultar estado
   *      ticket" devuelve `detalleTicket.nomArchivoImportacion`, que suena
   *      parecido pero no verifiqué que sea el mismo campo.
   * Construir el nombre "a ojo" a partir del patrón visto sería adivinar con
   * datos reales de SUNAT — mejor dejarlo marcado que arriesgar una descarga
   * que falla silenciosamente contra las credenciales reales de 171 empresas.
   */
  async consultarConstancia(_token: string, ruc: string, _periodoAnio: number, _periodoMes: number): Promise<ConstanciaSire> {
    throw new InternalServerErrorException(
      `SunatSireClient.consultarConstancia: falta confirmar cómo se obtiene 'nomConstanciaRecepcion' antes de RUC ${ruc}. ` +
      `El endpoint de descarga en sí (PUT/GET .../constancia/constanciarecepcion) ya está verificado contra el manual oficial, ver comentario.`,
    );
  }
}

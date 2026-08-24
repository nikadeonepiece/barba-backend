import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { CredencialesCryptoService } from '../../comun/credenciales-crypto.service';
import { SunatSireClient } from './sunat-sire.client';
import { SunatScrapingClient } from './sunat-scraping.client';

interface EmpresaParaVerificar {
  id_empresa: number;
  ruc: string;
  sunat_sol_usuario: Buffer | null;
  sunat_sol_password: Buffer | null;
  sunat_api_client_id: Buffer | null;
  sunat_api_client_secret: Buffer | null;
}

/**
 * FASE 2 — job de verificación automática. Pensado para correr una vez al día
 * (ej. 6-7am) antes de que el equipo llegue a la oficina, vía cron externo
 * (Windows Task Scheduler / crontab del hosting) que llame al endpoint
 * POST /vencimientos/sincronizacion-sunat/sincronizar, o instalando @nestjs/schedule y
 * decorando `ejecutar()` con @Cron() una vez que Fase 2 esté lista para producción.
 *
 * Regla de oro (definida en la conversación con el usuario): si falla la
 * verificación de una empresa, NUNCA se asume "no declarado" — queda marcada
 * ERROR_VERIFICACION con el motivo, y el resto de empresas sigue procesándose.
 */
@Injectable()
export class SunatSyncService {
  private readonly logger = new Logger(SunatSyncService.name);

  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private credencialesCrypto: CredencialesCryptoService,
    private sireClient: SunatSireClient,
    private scrapingClient: SunatScrapingClient,
  ) {}

  /**
   * Corre solo automáticamente si ENABLE_SUNAT_SYNC_CRON=true en el .env —
   * apagado por defecto a propósito, porque los clientes de SUNAT (SIRE
   * constancia y scraping) no están verificados contra el ambiente real
   * todavía (ver ESTADO_AVANCE.md). Activar recién cuando ambos funcionen,
   * para no generar cientos de ERROR_VERIFICACION todas las mañanas.
   *
   * 5:00am, todos los días (hora del servidor) — margen amplio antes de que
   * el equipo llegue a la oficina, dado que recorre ~150 empresas de forma
   * secuencial (con pausa entre cada una) y cada obligación de scraping abre
   * su propia sesión de navegador headless. El periodo tributario que se
   * verifica es el mes calendario anterior (regla general: lo que vence en
   * un mes corresponde al periodo del mes previo).
   */
  @Cron('0 5 * * *') // 5:00am todos los días
  async ejecutarProgramado() {
    if (process.env.ENABLE_SUNAT_SYNC_CRON !== 'true') {
      this.logger.debug('Cron de sincronización SUNAT desactivado (ENABLE_SUNAT_SYNC_CRON != true). Omitido.');
      return;
    }
    const hoy = new Date();
    const mesAnterior = hoy.getMonth() === 0 ? 12 : hoy.getMonth();
    const anioMesAnterior = hoy.getMonth() === 0 ? hoy.getFullYear() - 1 : hoy.getFullYear();
    this.logger.log(`Cron: iniciando sincronización automática del periodo ${mesAnterior}/${anioMesAnterior}`);
    await this.ejecutar(anioMesAnterior, mesAnterior);
  }

  async ejecutar(periodoAnio: number, periodoMes: number) {
    const empresas: EmpresaParaVerificar[] = await this.dataSource.query(
      `SELECT id_empresa, ruc, sunat_sol_usuario, sunat_sol_password, sunat_api_client_id, sunat_api_client_secret
       FROM empresa WHERE estado_registro = 'ACTIVO' AND estado_cliente = 'ACTIVO'`,
    );

    const resultado = { total: empresas.length, ok: 0, error: 0 };

    for (const empresa of empresas) {
      // Camino A — API oficial de SIRE, sin scraping. Independiente de la constancia
      // (que sigue bloqueada), esto ya corre de punta a punta si la empresa tiene
      // client_id/client_secret + Clave SOL cargados.
      await this.consultarCreditoFiscalSire(empresa, periodoAnio, periodoMes, resultado);

      // Camino B — descarga de constancia SIRE, bloqueado (falta nomConstanciaRecepcion).
      await this.verificarObligacion(empresa, periodoAnio, periodoMes, 'RCE_RVIE_SIRE', resultado);
      // Camino C — IGV_RENTA y PLANILLA, sin API oficial encontrada, vía scraping (bloqueado, falta URL de login real).
      await this.verificarObligacion(empresa, periodoAnio, periodoMes, 'IGV_RENTA', resultado);
      await this.verificarObligacion(empresa, periodoAnio, periodoMes, 'PLANILLA', resultado);

      // Pausa entre empresas: con ~150 empresas, atacar SUNAT sin espera puede
      // parecer un ataque de fuerza bruta y terminar bloqueando la IP del servidor.
      await this.dormir(1500);
    }

    this.logger.log(`Sincronización SUNAT ${periodoAnio}-${periodoMes}: ${resultado.ok} OK, ${resultado.error} con error, de ${resultado.total} empresas.`);
    return resultado;
  }

  private dormir(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Disparo manual desde el botón "Verificar con SUNAT" del Semáforo, una sola
  // empresa/obligación/periodo a la vez — a diferencia de `ejecutar()` (que
  // recorre TODAS las empresas), esto no arriesga golpear el WAF de SUNAT con
  // 171 empresas de golpe por un solo clic.
  async verificarUnaEmpresa(idEmpresa: number, tipo: 'RCE_RVIE_SIRE' | 'IGV_RENTA' | 'PLANILLA', periodoAnio: number, periodoMes: number) {
    const [empresa]: EmpresaParaVerificar[] = await this.dataSource.query(
      `SELECT id_empresa, ruc, sunat_sol_usuario, sunat_sol_password, sunat_api_client_id, sunat_api_client_secret
       FROM empresa WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!empresa) throw new Error('Empresa no encontrada');

    const resultado = { ok: 0, error: 0 };
    await this.verificarObligacion(empresa, periodoAnio, periodoMes, tipo, resultado);

    const [declaracion] = await this.dataSource.query(
      `SELECT estado_verificacion, fecha_declaracion, constancia_archivo, mensaje_error
       FROM declaracion WHERE id_empresa = ? AND periodo_anio = ? AND periodo_mes = ? AND tipo_obligacion = ?`,
      [idEmpresa, periodoAnio, periodoMes, tipo],
    );
    return { success: resultado.ok > 0, declaracion };
  }

  /**
   * Camino A (ver conversación): API oficial de SIRE, sin scraping. No toca
   * `declaracion` (eso sigue siendo de `verificarObligacion`) — guarda los 3
   * campos crudos en `credito_fiscal_sire`, sin forzar un mapeo a saldo_favor.
   */
  private async consultarCreditoFiscalSire(
    empresa: EmpresaParaVerificar,
    periodoAnio: number,
    periodoMes: number,
    resultado: { ok: number; error: number },
  ) {
    try {
      if (!empresa.sunat_api_client_id || !empresa.sunat_api_client_secret) return; // sin credenciales de API, se omite en silencio (no es un error, solo no aplica todavía)
      if (!empresa.sunat_sol_usuario || !empresa.sunat_sol_password) return;

      const clientId = this.credencialesCrypto.descifrar(empresa.sunat_api_client_id);
      const clientSecret = this.credencialesCrypto.descifrar(empresa.sunat_api_client_secret);
      const solUsuario = this.credencialesCrypto.descifrar(empresa.sunat_sol_usuario);
      const solPassword = this.credencialesCrypto.descifrar(empresa.sunat_sol_password);
      const token = await this.sireClient.obtenerToken(empresa.ruc, clientId, clientSecret, solUsuario, solPassword);
      const propuesta = await this.sireClient.consultarFV0621(token, periodoAnio, periodoMes);

      await this.dataSource.query(`CALL credito_fiscal_sire_registrar(?, ?, ?, ?, ?, ?)`, [
        empresa.id_empresa, periodoAnio, periodoMes, propuesta.factprorrata, propuesta.valorRCF, propuesta.valorCFE,
      ]);
      this.logger.log(`Crédito fiscal SIRE OK: empresa ${empresa.id_empresa} (${empresa.ruc}), periodo ${periodoAnio}-${periodoMes}`);
      resultado.ok++;
    } catch (error: any) {
      resultado.error++;
      this.logger.error(`Crédito fiscal SIRE falló: empresa ${empresa.id_empresa} (${empresa.ruc}): ${error?.message}`);
    }
  }

  private async verificarObligacion(
    empresa: EmpresaParaVerificar,
    periodoAnio: number,
    periodoMes: number,
    tipo: 'RCE_RVIE_SIRE' | 'IGV_RENTA' | 'PLANILLA',
    resultado: { ok: number; error: number },
  ) {
    try {
      if (tipo === 'RCE_RVIE_SIRE') {
        if (!empresa.sunat_api_client_id || !empresa.sunat_api_client_secret) {
          throw new Error('La empresa no tiene credenciales de API SUNAT registradas');
        }
        if (!empresa.sunat_sol_usuario || !empresa.sunat_sol_password) {
          // Corrección de diseño: el flujo OAuth2 de SIRE usa grant_type=password,
          // así que también necesita la Clave SOL, no solo el client_id/secret.
          throw new Error('La empresa no tiene Clave SOL registrada (requerida también para la API de SIRE)');
        }
        const clientId = this.credencialesCrypto.descifrar(empresa.sunat_api_client_id);
        const clientSecret = this.credencialesCrypto.descifrar(empresa.sunat_api_client_secret);
        const solUsuario = this.credencialesCrypto.descifrar(empresa.sunat_sol_usuario);
        const solPassword = this.credencialesCrypto.descifrar(empresa.sunat_sol_password);
        const token = await this.sireClient.obtenerToken(empresa.ruc, clientId, clientSecret, solUsuario, solPassword);
        const constancia = await this.sireClient.consultarConstancia(token, empresa.ruc, periodoAnio, periodoMes);
        // SIRE (Camino A) todavía no expone importe pagado en esta consulta — pago_verificado=0
        // deja estado_pago intacto (no lo pisa con NO_PAGADO por falta de dato).
        await this.dataSource.query(`CALL declaracion_marcar_automatico(?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          empresa.id_empresa, periodoAnio, periodoMes, tipo,
          constancia.fechaConstancia ? new Date(constancia.fechaConstancia) : null, // mysql2 necesita Date real, no string ISO (ver declaraciones.service.ts)
          constancia.urlConstancia,
          0, null, null,
        ]);
      } else {
        if (!empresa.sunat_sol_usuario || !empresa.sunat_sol_password) {
          throw new Error('La empresa no tiene Clave SOL registrada');
        }
        const solUsuario = this.credencialesCrypto.descifrar(empresa.sunat_sol_usuario);
        const solPassword = this.credencialesCrypto.descifrar(empresa.sunat_sol_password);
        const resultadoScraping = await this.scrapingClient.consultarDeclaracion(
          empresa.ruc, solUsuario, solPassword, tipo, periodoAnio, periodoMes,
        );
        // Fecha de pago: SUNAT no muestra una fecha de pago separada en esta pantalla —
        // se usa la misma fecha de presentación como referencia, solo cuando sí hubo importe.
        // pago_verificado=1: esta fila SÍ se leyó completa (columna de importe incluida),
        // así que ausencia de importe es NO_PAGADO real, no "no se sabe".
        await this.dataSource.query(`CALL declaracion_marcar_automatico(?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          empresa.id_empresa, periodoAnio, periodoMes, tipo,
          resultadoScraping.fechaDeclaracion ? new Date(resultadoScraping.fechaDeclaracion) : null,
          resultadoScraping.rutaConstanciaDescargada,
          resultadoScraping.declarado ? 1 : 0,
          resultadoScraping.importePagado,
          resultadoScraping.importePagado && resultadoScraping.fechaDeclaracion ? new Date(resultadoScraping.fechaDeclaracion) : null,
        ]);
      }
      resultado.ok++;
    } catch (error: any) {
      resultado.error++;
      const mensaje = error?.message ?? 'Error desconocido al verificar con SUNAT';
      this.logger.error(`Empresa ${empresa.id_empresa} (${empresa.ruc}) - ${tipo}: ${mensaje}`);
      await this.dataSource.query(`CALL declaracion_marcar_error(?, ?, ?, ?, ?)`, [
        empresa.id_empresa, periodoAnio, periodoMes, tipo, mensaje.slice(0, 500),
      ]);
    }
  }
}

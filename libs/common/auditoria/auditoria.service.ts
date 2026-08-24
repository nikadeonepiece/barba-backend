import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

export type AccionAuditoria = 'CREAR' | 'ACTUALIZAR' | 'ELIMINAR' | 'ANULAR';

/** Coincide con el ENUM `accion` de sis_auditoria en bd.sql. */
const SP_REGISTRAR = 'CALL sis_auditoria_registrar(?, ?, ?, ?, ?, ?)';

@Injectable()
export class AuditoriaService {
  private readonly logger = new Logger(AuditoriaService.name);

  constructor(@InjectDataSource('ESTUDIOBARBA_CONN') private readonly db: DataSource) {}

  /**
   * Los dos métodos usan el stored procedure `sis_auditoria_registrar` en vez de
   * un INSERT propio: bd.sql marca los procedimientos de auditoría como core, y
   * asi la estructura de la tabla se toca en un solo lugar.
   */
  private parametros(
    nombreTabla: string,
    idRegistro: number,
    accion: AccionAuditoria,
    idUsuario: number,
    valoresAntiguos: any,
    valoresNuevos: any,
  ) {
    return [
      nombreTabla,
      idRegistro,
      accion,
      idUsuario,
      valoresAntiguos ? JSON.stringify(valoresAntiguos) : null,
      valoresNuevos ? JSON.stringify(valoresNuevos) : null,
    ];
  }

  /**
   * Guardado simple, fuera de transacciones.
   *
   * Traga el error a propósito: que falle la auditoría no debe tumbar la
   * operación de negocio que la disparó. Queda registrado en el log.
   */
  async registrar(
    nombreTabla: string,
    idRegistro: number,
    accion: AccionAuditoria,
    idUsuario: number,
    valoresAntiguos: any = null,
    valoresNuevos: any = null,
  ) {
    try {
      await this.db.query(
        SP_REGISTRAR,
        this.parametros(nombreTabla, idRegistro, accion, idUsuario, valoresAntiguos, valoresNuevos),
      );
      this.logger.log(`✅ Auditoría guardada con éxito: ${accion} en ${nombreTabla}`);
    } catch (error) {
      this.logger.error(
        `❌ Error al intentar guardar auditoría en ${nombreTabla} (ID: ${idRegistro})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Guardado atado a un QueryRunner, para que entre en la misma transacción que
   * la operación auditada.
   *
   * Al contrario del método de arriba, acá el error SÍ se relanza: si la
   * auditoría no se puede escribir, la transacción entera debe abortar — si no,
   * el cambio quedaría grabado sin rastro de quién lo hizo.
   */
  async registrarConTransaccion(
    queryRunner: QueryRunner,
    nombreTabla: string,
    idRegistro: number,
    accion: AccionAuditoria,
    idUsuario: number,
    valoresAntiguos: any = null,
    valoresNuevos: any = null,
  ) {
    try {
      await queryRunner.query(
        SP_REGISTRAR,
        this.parametros(nombreTabla, idRegistro, accion, idUsuario, valoresAntiguos, valoresNuevos),
      );
      this.logger.log(`✅ Auditoría en TX guardada: ${accion} en ${nombreTabla}`);
    } catch (error) {
      this.logger.error(`❌ Error en auditoría TX en ${nombreTabla} (ID: ${idRegistro})`);
      throw error; // Aborta la transacción principal
    }
  }
}

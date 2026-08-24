import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AsistenteIaBaseService } from '../ia/asistente-ia-base.service';

const SYSTEM_PROMPT = `Eres el asistente de detección de inconsistencias de un estudio contable en Perú.
Recibes una lista YA CALCULADA de alertas detectadas por código (saldo a favor sin usar hace meses,
diferencias entre el cálculo preliminar y la declaración oficial). Tu tarea es explicar cada alerta
en una frase clara para el equipo, en español, sin inventar cifras ni empresas que no estén en la lista.
No des consejos tributarios ni conclusiones legales — solo señala el patrón detectado, de forma neutral.`;

/**
 * FASE 3 (MVP prioridad 2): Deus. Detecta, con código determinístico:
 *   1. Saldo a favor que lleva 2+ meses seguidos sin bajar a cero (posible crédito perdido de vista)
 *   2. Diferencias entre el corte preliminar y la declaración oficial del mismo periodo
 * La IA solo redacta la explicación de lo que el código ya encontró.
 */
@Injectable()
export class DeteccionInconsistenciasService {
  private readonly logger = new Logger(DeteccionInconsistenciasService.name);

  constructor(
    @InjectDataSource('DENTAONEPIECE_CONN') private dataSource: DataSource,
    private ia: AsistenteIaBaseService,
  ) {}

  async analizar(userId: number) {
    const alertas: string[] = [];

    const saldosArrastrados = await this.dataSource.query(`
      SELECT e.razon_social, s.tipo_impuesto, COUNT(*) AS meses_seguidos, MAX(s.monto) AS ultimo_monto
      FROM saldo_favor s
      JOIN empresa e ON e.id_empresa = s.id_empresa
      WHERE s.fuente = 'DECLARACION_OFICIAL' AND s.monto > 0
        AND s.periodo_anio >= YEAR(CURDATE()) - 1
      GROUP BY s.id_empresa, s.tipo_impuesto
      HAVING meses_seguidos >= 2
    `);
    for (const fila of saldosArrastrados) {
      alertas.push(
        `${fila.razon_social}: saldo a favor de ${fila.tipo_impuesto} presente en ${fila.meses_seguidos} periodos consecutivos, último monto S/ ${fila.ultimo_monto}.`,
      );
    }

    const diferencias = await this.dataSource.query(`
      SELECT e.razon_social, c.periodo_anio, c.periodo_mes, c.resultado_igv AS preliminar,
             d.monto AS declarado_oficial
      FROM corte_preliminar c
      JOIN empresa e ON e.id_empresa = c.id_empresa
      LEFT JOIN saldo_favor d ON d.id_empresa = c.id_empresa AND d.periodo_anio = c.periodo_anio
        AND d.periodo_mes = c.periodo_mes AND d.tipo_impuesto = 'IGV' AND d.fuente = 'DECLARACION_OFICIAL'
      WHERE d.monto IS NOT NULL AND ABS(c.resultado_igv - d.monto) > 1.00
    `);
    for (const fila of diferencias) {
      alertas.push(
        `${fila.razon_social} (${fila.periodo_mes}/${fila.periodo_anio}): el corte preliminar calculó S/ ${fila.preliminar} y la declaración oficial dice S/ ${fila.declarado_oficial} — diferencia sin explicar.`,
      );
    }

    const textoRedactado = await this.redactarConIA(alertas, userId);
    return { success: true, alertas, texto: textoRedactado };
  }

  private async redactarConIA(alertas: string[], userId: number): Promise<string> {
    if (alertas.length === 0) return 'No se detectaron inconsistencias en esta revisión.';
    if (!this.ia.iaDisponible) return alertas.join('\n');
    try {
      return await this.ia.completar('DETECCION_INCONSISTENCIAS', SYSTEM_PROMPT, JSON.stringify(alertas), userId);
    } catch (error) {
      this.logger.error('Fallo la redacción con IA, se usa la lista sin IA como respaldo', error as any);
      return alertas.join('\n');
    }
  }
}

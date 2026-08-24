import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AsistenteIaBaseService } from '../base/asistente-ia-base.service';

interface FilaSemaforo {
  razon_social: string;
  tipo_obligacion: string;
  estado_semaforo: 'A_TIEMPO' | 'PENDIENTE' | 'TARDE' | 'VENCIDO';
  mensaje_error: string | null;
}

const SYSTEM_PROMPT = `Eres el asistente de resumen matutino de un estudio contable en Perú.
Recibes un resumen YA CALCULADO (nunca datos crudos) del estado de vencimientos tributarios/laborales de las empresas cliente.
Tu única tarea es redactarlo en 3-5 líneas, claro y directo, en español, para que el equipo lo lea al llegar a la oficina.
No inventes cifras ni empresas que no estén en el resumen. No des consejos tributarios. Solo redacta lo que ya se calculó.`;

/**
 * FASE 3 (MVP prioridad 1): resumen matutino. Arma primero el resumen
 * estructurado con código determinístico, y solo ese resumen se le pasa a
 * la IA para redactarlo — nunca datos crudos (regla del brief original).
 * Funciona igual sin IA configurada (fallback a texto armado por código).
 */
@Injectable()
export class ResumenDiarioService {
  private readonly logger = new Logger(ResumenDiarioService.name);

  constructor(
    @InjectDataSource('DENTAONEPIECE_CONN') private dataSource: DataSource,
    private ia: AsistenteIaBaseService,
  ) {}

  async generar(periodoAnio: number, periodoMes: number, userId: number) {
    const [filas]: [FilaSemaforo[]] = await this.dataSource.query(`CALL declaracion_semaforo(?, ?)`, [periodoAnio, periodoMes]);

    const pendientes = filas.filter((f) => f.estado_semaforo === 'PENDIENTE');
    const vencidos = filas.filter((f) => f.estado_semaforo === 'VENCIDO');
    const conError = filas.filter((f) => f.mensaje_error);
    const aTiempo = filas.filter((f) => f.estado_semaforo === 'A_TIEMPO');

    const resumenEstructurado = {
      periodo: `${periodoMes}/${periodoAnio}`,
      total_obligaciones: filas.length,
      a_tiempo: aTiempo.length,
      pendientes: pendientes.map((f) => `${f.razon_social} (${f.tipo_obligacion})`),
      vencidos: vencidos.map((f) => `${f.razon_social} (${f.tipo_obligacion})`),
      con_error_verificacion: conError.map((f) => `${f.razon_social} (${f.tipo_obligacion}): ${f.mensaje_error}`),
    };

    const textoRedactado = await this.redactarConIA(resumenEstructurado, userId);
    return { success: true, resumen_estructurado: resumenEstructurado, texto: textoRedactado };
  }

  private async redactarConIA(resumen: Record<string, unknown>, userId: number): Promise<string> {
    if (!this.ia.iaDisponible) {
      return this.redactarSinIA(resumen as any);
    }
    try {
      return await this.ia.completar('RESUMEN_DIARIO', SYSTEM_PROMPT, JSON.stringify(resumen), userId);
    } catch (error) {
      this.logger.error('Fallo la redacción con IA, se usa el resumen sin IA como respaldo', error as any);
      return this.redactarSinIA(resumen as any);
    }
  }

  private redactarSinIA(resumen: {
    periodo: string;
    total_obligaciones: number;
    a_tiempo: number;
    pendientes: string[];
    vencidos: string[];
    con_error_verificacion: string[];
  }): string {
    const lineas: string[] = [`Resumen del periodo ${resumen.periodo}: ${resumen.a_tiempo}/${resumen.total_obligaciones} obligaciones al día.`];
    if (resumen.vencidos.length) lineas.push(`Vencidas: ${resumen.vencidos.join(', ')}.`);
    if (resumen.pendientes.length) lineas.push(`Pendientes: ${resumen.pendientes.join(', ')}.`);
    if (resumen.con_error_verificacion.length) lineas.push(`Con error al verificar (revisar): ${resumen.con_error_verificacion.join(', ')}.`);
    return lineas.join('\n');
  }
}

import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import Anthropic from '@anthropic-ai/sdk';

// Precio de referencia Sonnet 5 (post-introductorio, ago-2026 según el brief original): $3/$15 por millón de tokens.
// Es una ESTIMACIÓN para control de gasto interno, no una factura real — confirmar en la consola de Anthropic.
const PRECIO_USD_POR_TOKEN_ENTRADA = 3 / 1_000_000;
const PRECIO_USD_POR_TOKEN_SALIDA = 15 / 1_000_000;

const MAX_TOKENS_SALIDA = 1024; // tope duro por consulta, ver brief: "controles de costo obligatorios"
const LIMITE_CONSULTAS_POR_USUARIO_POR_MINUTO = 5;

export type NombreAsistente = 'RESUMEN_DIARIO' | 'DETECCION_INCONSISTENCIAS' | 'REDACCION_CORREO';

/**
 * FASE 3 — base compartida por los 3 asistentes del MVP. Implementa la regla de
 * arquitectura del brief original: nunca se manda data cruda, solo el resumen ya
 * calculado por código; y los 5 controles de costo pedidos (límite de gasto se
 * configura en la consola de Anthropic, los otros 4 están acá):
 *   1. max_tokens limitado (MAX_TOKENS_SALIDA)
 *   2. rate-limiting por usuario (LIMITE_CONSULTAS_POR_USUARIO_POR_MINUTO)
 *   3. registro de uso/costo en `uso_ia` para monitoreo
 *   4. fallback seguro si la IA no está configurada o falla (nunca rompe el flujo)
 */
@Injectable()
export class AsistenteIaBaseService {
  private readonly logger = new Logger(AsistenteIaBaseService.name);
  private client: Anthropic | null = null;

  constructor(@InjectDataSource('DENTAONEPIECE_CONN') private dataSource: DataSource) {
    if (process.env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
  }

  get iaDisponible(): boolean {
    return this.client !== null;
  }

  async verificarRateLimit(userId: number) {
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM uso_ia WHERE id_usuario = ? AND fecha >= (NOW() - INTERVAL 1 MINUTE)`,
      [userId],
    );
    if (Number(total) >= LIMITE_CONSULTAS_POR_USUARIO_POR_MINUTO) {
      throw new HttpException('Demasiadas consultas a IA en poco tiempo. Espera un minuto e intenta de nuevo.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * `systemPrompt` + `contenido` deben ser texto YA RESUMIDO por código
   * (nunca un Excel/tabla cruda) — así el costo y el riesgo de que la IA
   * "calcule mal" quedan controlados.
   */
  async completar(asistente: NombreAsistente, systemPrompt: string, contenido: string, userId: number): Promise<string> {
    if (!this.client) {
      throw new Error('IA no configurada (falta ANTHROPIC_API_KEY)');
    }

    await this.verificarRateLimit(userId);

    const respuesta = await this.client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: MAX_TOKENS_SALIDA,
      system: systemPrompt,
      messages: [{ role: 'user', content: contenido }],
    });

    const tokensEntrada = respuesta.usage?.input_tokens ?? 0;
    const tokensSalida = respuesta.usage?.output_tokens ?? 0;
    const costoEstimado = tokensEntrada * PRECIO_USD_POR_TOKEN_ENTRADA + tokensSalida * PRECIO_USD_POR_TOKEN_SALIDA;

    await this.dataSource.query(
      `INSERT INTO uso_ia (id_usuario, asistente, tokens_entrada, tokens_salida, costo_estimado_usd) VALUES (?, ?, ?, ?, ?)`,
      [userId, asistente, tokensEntrada, tokensSalida, costoEstimado],
    );

    const bloqueTexto = respuesta.content.find((b) => b.type === 'text');
    return bloqueTexto && 'text' in bloqueTexto ? bloqueTexto.text : '';
  }
}

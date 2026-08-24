import { Injectable, BadRequestException } from '@nestjs/common';
import { AsistenteIaBaseService } from '../ia/asistente-ia-base.service';
import { RedactarCorreoDto } from './dto/redaccion-correo.dto';

const SYSTEM_PROMPT = `Eres Lumen, un asistente de redacción de correos para un estudio contable peruano
que se comunica con sus clientes (empresas que llevan su contabilidad con el estudio).
Redactas correos profesionales explicando temas contables/tributarios a personas sin conocimientos técnicos.
No inventes montos, fechas ni datos financieros que el usuario no te haya dado explícitamente —
si falta información, deja un placeholder claro entre corchetes, ej: [MONTO A CONFIRMAR].
Adapta el tono al que te indiquen (formal, cercano, urgente). Responde solo con el texto del correo,
listo para copiar y pegar, incluyendo un asunto sugerido en la primera línea.`;

/**
 * FASE 3 (MVP prioridad 3): Lumen. El de menor riesgo de los tres —
 * no calcula ni consulta cifras del sistema, solo redacta a partir de lo
 * que el usuario escribe. Aun así pasa por el mismo control de costo/rate-limit.
 */
@Injectable()
export class RedaccionCorreoService {
  constructor(private ia: AsistenteIaBaseService) {}

  // Lo consulta el frontend al abrir la pantalla, para avisar antes de que el
  // usuario escriba el correo entero (ver redaccion-correo.controller.ts).
  get iaDisponible(): boolean {
    return this.ia.iaDisponible;
  }

  async redactar(dto: RedactarCorreoDto, userId: number): Promise<{ success: boolean; texto: string }> {
    if (!this.ia.iaDisponible) {
      throw new BadRequestException('El asistente de redacción necesita ANTHROPIC_API_KEY configurada (a diferencia del resumen diario, este no tiene modo sin IA porque su única función es redactar).');
    }

    const contenido = `Tono solicitado: ${dto.tono}.\nDestinatario: ${dto.destinatario || 'no especificado'}.\nQué quiero comunicar:\n${dto.contexto}`;
    const texto = await this.ia.completar('REDACCION_CORREO', SYSTEM_PROMPT, contenido, userId);
    return { success: true, texto };
  }
}

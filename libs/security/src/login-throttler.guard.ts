import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limit del login contado por CUENTA (correo + IP), no solo por IP.
 *
 * Todo el estudio sale a internet por una sola IP pública. Con el límite por IP,
 * la 6.ª persona que entraba en el mismo minuto recibía 429 aunque su contraseña
 * fuera correcta, y a una sola persona equivocándose dos veces le bastaba para
 * dejar sin login al resto de la oficina.
 *
 * Contar por correo mantiene la protección real contra fuerza bruta (que apunta
 * SIEMPRE a una cuenta concreta) sin castigar a los compañeros. La IP se conserva
 * dentro de la clave para que un atacante no pueda bloquear la cuenta de otro
 * desde afuera: su tope se consume en su propia IP, no en la del usuario legítimo.
 */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ip = req.ips?.length ? req.ips[0] : req.ip;
    const correo = String(req.body?.correo || '').trim().toLowerCase();
    return correo ? `login:${ip}:${correo}` : `login:${ip}`;
  }
}

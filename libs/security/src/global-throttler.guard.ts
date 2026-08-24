import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limit global (300 req/min por IP) para TODA la API, menos `/auth/login`.
 *
 * El login lo cuenta `LoginThrottlerGuard`, por correo+IP. Si el guard global
 * también lo contara, aplicaría el `@Throttle` del login pero por IP suelta, y
 * como todo el estudio sale por una sola IP pública volveríamos al problema de
 * que la oficina comparte el mismo cupo de intentos.
 *
 * Se resuelve con `shouldSkip` (propio de cada guard) y NO con la opción `skipIf`
 * del módulo: `skipIf` es una opción común del ThrottlerModule y la heredaría
 * también `LoginThrottlerGuard`, que terminaría saltándose a sí mismo — o sea, el
 * login se quedaría literalmente sin límite de intentos.
 */
@Injectable()
export class GlobalThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const url: string = context.switchToHttp().getRequest()?.url || '';
    return url.includes('/auth/login');
  }
}

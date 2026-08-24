import { Injectable, NestInterceptor, ExecutionContext, CallHandler, RequestTimeoutException } from '@nestjs/common';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { timeout, catchError } from 'rxjs/operators';

// Protección del pool (ver CLAUDE.md §4): si una query se queda colgada (deadlock,
// lock de tabla), sin esto la petición nunca termina, el `finally` que hace
// `qr.release()` no llega a correr y el pool se agota (`ER_CON_COUNT_ERROR`) —
// a partir de ahí TODO el ERP deja de responder, no solo esa pantalla.
const TIMEOUT_MS_DEFAULT = 15_000;

// Rutas que legítimamente tardan más que un CRUD y no deben cortarse a los 15s:
// scraping/consultas contra SUNAT (Playwright abre un navegador real, con pausa
// entre empresas), descargas SIRE y los exports.
const RUTAS_LARGAS: Array<{ patron: RegExp; ms: number }> = [
  { patron: /\/vencimientos\/fase2\//i, ms: 180_000 },
  { patron: /\/vencimientos\/sire\//i, ms: 180_000 },
  // Casilla SUNAFIL: no hay API, se lee el portal con Playwright pasando por el
  // OAuth2 de SUNAT — un login completo más la carga de la bandeja no entra en 15s.
  { patron: /\/vencimientos\/sunafil\//i, ms: 180_000 },
  { patron: /\/vencimientos\/fase3\//i, ms: 60_000 },
  { patron: /\/exportar\//i, ms: 60_000 },
  { patron: /\/constancias\//i, ms: 60_000 },
];

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const url: string = context.switchToHttp().getRequest()?.url || '';
    const regla = RUTAS_LARGAS.find((r) => r.patron.test(url));
    const ms = regla ? regla.ms : TIMEOUT_MS_DEFAULT;

    return next.handle().pipe(
      timeout(ms),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => new RequestTimeoutException(
            'La operación tardó demasiado y fue cancelada. Vuelve a intentarlo; si se repite, avisa a soporte.',
          ));
        }
        return throwError(() => err);
      }),
    );
  }
}

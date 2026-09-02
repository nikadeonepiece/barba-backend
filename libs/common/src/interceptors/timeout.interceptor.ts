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
  // Playwright (navegador real contra SUNAT/SUNAFIL): login + navegación + descarga
  // no entran en 15s ni de lejos. Los patrones tienen que coincidir con el prefijo
  // REAL del @Controller(): si un módulo se renombra, hay que actualizarlos acá o
  // vuelve a cortarse a los 15s con un 408 — le pasó a sincronizacion-sunat, que
  // acá seguía listado con su nombre viejo (/vencimientos/fase2/).
  { patron: /\/vencimientos\/sincronizacion-sunat\//i, ms: 180_000 },
  { patron: /\/vencimientos\/sire\//i, ms: 180_000 },
  { patron: /\/vencimientos\/buzon-sunat\//i, ms: 180_000 },
  // Casilla SUNAFIL: no hay API, se lee el portal con Playwright pasando por el
  // OAuth2 de SUNAT — un login completo más la carga de la bandeja no entra en 15s.
  { patron: /\/vencimientos\/sunafil\//i, ms: 180_000 },
  // Abre la ventana de "Mis declaraciones" con Playwright (headless: false).
  { patron: /\/abrir-mis-declaraciones/i, ms: 180_000 },
  // T-Registro (planilla/trabajadores): login SOL + 5 niveles de menú + lectura del
  // padrón. Se cortaba a los 15s con un 408 justo cuando ya estaba entrando a la
  // pantalla — el síntoma engañaba, porque parecía que el scraper se colgaba.
  // Se listan por el sufijo de la acción y no por el prefijo del módulo: la ruta
  // real lleva el id de empresa en el medio
  // (/planilla/trabajadores/empresas/57/consultar-tregistro).
  // 10 minutos y no 3: el T-Registro no trae el sueldo en el listado, así que hay
  // que ABRIR LA FICHA DE CADA TRABAJADOR. El tiempo crece con la planilla — 11
  // fichas rozaban los 3 minutos y la petición se cortaba con la lectura casi
  // terminada, que es el peor momento posible: se gastó la sesión de SUNAT igual.
  { patron: /\/consultar-tregistro/i, ms: 600_000 },
  { patron: /\/abrir-tregistro/i, ms: 180_000 },
  // Asistentes de IA: dependen de la latencia del modelo (antes /vencimientos/fase3/).
  { patron: /\/vencimientos\/asistentes-ia\//i, ms: 60_000 },
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

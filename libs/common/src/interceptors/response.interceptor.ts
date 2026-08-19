import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Response<T> {
  success: boolean;
  message: string;
  data: T;
  timestamp: string;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, Response<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T>> {
    return next.handle().pipe(
      map((data) => {
        const message = (data && data.mensaje) ? data.mensaje : 'Operación exitosa';
        if (data && data.mensaje) delete data.mensaje;

        return {
          success: true,
          message: message,
          data: data,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
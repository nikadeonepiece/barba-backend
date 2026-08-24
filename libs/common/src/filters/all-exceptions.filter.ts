import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

// El decorador @Catch() vacío significa que atrapará ABSOLUTAMENTE TODOS los errores
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // 1. Determinamos el código de estado HTTP (puede ajustarse abajo, ej. ER_DUP_ENTRY -> 409)
    let status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // 2. Extraemos el mensaje del error
    let message = 'Error interno del servidor';

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      // Si el error viene de las validaciones de nuestro DTO, extraemos ese mensaje específico
      message = typeof exceptionResponse === 'string'
        ? exceptionResponse
        : (exceptionResponse as any).message || exception.message;

      // El rate limit responde "ThrottlerException: Too Many Requests" — en inglés y
      // sin decir qué hacer. El usuario final ve este texto tal cual en el toast.
      if (status === HttpStatus.TOO_MANY_REQUESTS && String(message).includes('ThrottlerException')) {
        message = request.url?.includes('/auth/login')
          ? 'Demasiados intentos de acceso con este correo. Espera un minuto y vuelve a intentar.'
          : 'Estás haciendo demasiadas solicitudes seguidas. Espera un momento y vuelve a intentar.';
      }
    } else if (exception instanceof Error) {
      // ⚠️ AQUÍ ESTÁ LA MAGIA PARA SQL NATIVO
      // Si el error es de base de datos (Ej: ER_DUP_ENTRY en MySQL), lo atrapamos
      // y lo registramos en consola para nosotros (los desarrolladores),
      // pero le enviamos un mensaje genérico al usuario.
      console.error(`[ERROR NO CONTROLADO] en ${request.url}:`, exception.message);

      if (exception.message.includes('ER_DUP_ENTRY')) {
        status = HttpStatus.CONFLICT;
        message = 'El registro que intenta crear ya existe en el sistema.';
      }
    }

    // 3. Estructuramos la respuesta final que SIEMPRE recibirá el Frontend
    response.status(status).json({
      exito: false, // Bandera rápida para que el Frontend sepa que falló
      estado: status,
      mensaje: message,
      ruta: request.url,
      fecha: new Date().toISOString(),
    });
  }
}
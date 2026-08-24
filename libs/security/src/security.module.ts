import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { GlobalThrottlerGuard } from './global-throttler.guard';

@Module({
  imports: [
    // Configuración centralizada: Si cambias el límite aquí, se actualiza en TODAS tus apps
    ThrottlerModule.forRoot([{
      ttl: 60000,  // 1 minuto
      limit: 300,  // 300 peticiones por minuto
    }]),
  ],
  providers: [
    // Esto activa el escudo automáticamente en cualquier App que importe este módulo.
    // `GlobalThrottlerGuard` (no el `ThrottlerGuard` pelado) para que `/auth/login`
    // quede a cargo de `LoginThrottlerGuard`, que cuenta por correo+IP — ver el
    // comentario de esos dos archivos.
    {
      provide: APP_GUARD,
      useClass: GlobalThrottlerGuard,
    },
  ],
  exports: [ThrottlerModule], // Exportamos por si alguna App necesita configuración extra
})
export class SecurityModule {}

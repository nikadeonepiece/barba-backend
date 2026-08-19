import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

@Module({
  imports: [
    // Configuración centralizada: Si cambias el límite aquí, se actualiza en TODAS tus apps
    ThrottlerModule.forRoot([{
      ttl: 60000,  // 1 minuto
      limit: 300,  // 300 peticiones por minuto
    }]),
  ],
  providers: [
    // Esto activa el escudo automáticamente en cualquier App que importe este módulo
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
  exports: [ThrottlerModule], // Exportamos por si alguna App necesita configuración extra
})
export class SecurityModule {}
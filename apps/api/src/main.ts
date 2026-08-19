process.env.TZ = 'America/Lima';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express'; // 🔥 NUEVO: Para servir archivos estáticos
import { join } from 'path'; // 🔥 NUEVO: Para manejar las rutas de las carpetas
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { ApiModule } from './api.module';
import { AllExceptionsFilter, TransformInterceptor } from '@app/common';
import { winstonConfig } from '@app/logger';
import { WinstonModule } from 'nest-winston';

async function bootstrap() {
  // 🔥 Usamos NestExpressApplication para habilitar la exposición de la carpeta 'uploads'
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    logger: WinstonModule.createLogger(winstonConfig),
  });

  app.enableShutdownHooks();

  // Necesario para leer la cookie httpOnly del refresh token en POST /auth/refresh y /auth/logout
  app.use(cookieParser());

  const globalPrefix = process.env.API_PREFIX || 'api';
  app.setGlobalPrefix(globalPrefix);

  // 🔥 AJUSTADO: Helmet bloquea la visualización de imágenes/PDFs externos por defecto. 
  // Esto lo flexibiliza para que el frontend pueda mostrar los archivos del ERP.
  app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  }));

  // ✅ CORS configurado y seguro para producción y tu frontend local
  app.enableCors({
    origin: [
      'http://localhost:4200',
      'http://localhost:62003',
            'http://barba.difusioneslaborales.com'
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalInterceptors(new TransformInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  // 🔥 NUEVO: Exponer la carpeta "uploads" para que el frontend pueda descargar/ver los archivos
  // Se asume que la carpeta 'uploads' estará en la raíz del backend
  app.useStaticAssets(join(__dirname, '..', '..', '..', 'uploads'), {
    prefix: '/uploads/',
  });

  const port = process.env.PORT || 3777;
  await app.listen(port);
  console.log(`🚀 API corriendo en puerto: ${port} con prefijo: ${globalPrefix}`);
}
bootstrap();
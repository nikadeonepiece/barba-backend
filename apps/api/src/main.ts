process.env.TZ = 'America/Lima';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express'; // 🔥 NUEVO: Para servir archivos estáticos
import { join } from 'path'; // 🔥 NUEVO: Para manejar las rutas de las carpetas
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { ApiModule } from './api.module';
import { AllExceptionsFilter, TransformInterceptor, TimeoutInterceptor } from '@app/common';
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
      'http://localhost:57035',
      'http://barba.difusioneslaborales.com',
      // El frontend de producción (environment.ts) apunta a HTTPS — sin este origen
      // el navegador bloquea por CORS toda llamada al API si no se sirve same-origin.
      'https://barba.difusioneslaborales.com',
      'https://www.barba.difusioneslaborales.com'
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

  // TimeoutInterceptor PRIMERO: si una query se cuelga, corta la petición y deja que
  // el `finally` libere la conexión, en vez de agotar el pool y tumbar todo el ERP.
  app.useGlobalInterceptors(new TimeoutInterceptor(), new TransformInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  // Expone la carpeta "uploads" para que el frontend pueda descargar/ver los archivos.
  //
  // Se sirve desde process.cwd() PRIMERO y desde __dirname como respaldo, porque las
  // dos rutas apuntan a lugares distintos según dónde corra el proceso:
  //   - en la PC:  el bundle está en dist/apps/api/, así que __dirname/../../..
  //                cae en la raíz del proyecto — igual que cwd.
  //   - en cPanel: main.js vive en la RAÍZ de la app (no hay carpeta dist/), así que
  //                __dirname/../../.. se sale de la app y cae en /home/difusion.
  //                cwd, en cambio, Passenger lo fija en la raíz de la app: correcto.
  // El resto del backend (storage-privado/, logs/) ya usa process.cwd(); ésta era la
  // única ruta que no lo hacía.
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });
  app.useStaticAssets(join(__dirname, '..', '..', '..', 'uploads'), { prefix: '/uploads/' });

  const port = process.env.PORT || 3777;
  await app.listen(port);
  console.log(`🚀 API corriendo en puerto: ${port} con prefijo: ${globalPrefix}`);
}
bootstrap();
import { format, transports } from 'winston';
import * as path from 'path';
import 'winston-daily-rotate-file';

export const winstonConfig = {
  // 1. Formato Global (se aplica a todos los archivos si no se sobrescribe)
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }), // Guarda el stack trace si hay error
    format.json(),
  ),
  transports: [
    // A. Consola (Para ver en vivo con colores)
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple(),
      ),
    }),

    // B. Archivo de ERRORES (Solo guarda cuando algo explota)
    new transports.DailyRotateFile({
      filename: path.join(process.cwd(), 'logs/error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      level: 'error', // <--- Esto ya hace el trabajo de filtrar solo errores
    }),

    // C. Archivo COMBINADO (Guarda Info, Warn y Error)
    new transports.DailyRotateFile({
      filename: path.join(process.cwd(), 'logs/combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      level: 'info', // <--- Guarda desde 'info' hacia arriba (incluye errores)
    }),
  ],
};
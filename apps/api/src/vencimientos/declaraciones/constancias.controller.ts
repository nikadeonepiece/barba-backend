import { Controller, Post, Body, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { ConstanciasExtraccionService } from './constancias-extraccion.service';
import { ExtraerConstanciaDto } from './dto/extraer-constancia.dto';

const CARPETA_CONSTANCIAS = 'uploads/constancias';

const CONFIG_SUBIDA = {
  storage: diskStorage({
    destination: CARPETA_CONSTANCIAS,
    filename: (_req: any, file: any, cb: any) => {
      const sufijo = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `constancia-${sufijo}${extname(file.originalname)}`);
    },
  }),
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new BadRequestException('Solo se aceptan archivos PDF'), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
};

/**
 * Subida de constancias de declaración (PDF). Se guarda en disco local
 * (carpeta `uploads/constancias`, ya expuesta como estática en main.ts) y se
 * devuelve la ruta relativa para guardarla en `declaracion.constancia_archivo`.
 * No borra archivos viejos automáticamente — si se resube una constancia para
 * el mismo periodo, el archivo anterior queda huérfano en disco (aceptable
 * para el volumen de este estudio; revisar si el storage crece mucho).
 */
@Controller('vencimientos/constancias')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ConstanciasController {
  constructor(private readonly extraccionService: ConstanciasExtraccionService) {}

  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'marcar_declaracion')
  @Post('subir')
  @UseInterceptors(FileInterceptor('archivo', CONFIG_SUBIDA))
  subir(@UploadedFile() archivo: Express.Multer.File) {
    if (!archivo) throw new BadRequestException('No se recibió ningún archivo');
    return { success: true, ruta: `/${CARPETA_CONSTANCIAS}/${archivo.filename}` };
  }

  // Mismo almacenamiento, permiso laboral — sin este endpoint, un usuario con solo
  // VENCIMIENTOS_LABORAL no puede subir la constancia de Planilla/AFP.
  @RequirePermissions('VENCIMIENTOS_LABORAL', 'marcar_declaracion_laboral')
  @Post('laboral/subir')
  @UseInterceptors(FileInterceptor('archivo', CONFIG_SUBIDA))
  subirLaboral(@UploadedFile() archivo: Express.Multer.File) {
    if (!archivo) throw new BadRequestException('No se recibió ningún archivo');
    return { success: true, ruta: `/${CARPETA_CONSTANCIAS}/${archivo.filename}` };
  }

  // Extracción SIN IA (pdf-parse + detección de tabla) — solo lectura, no guarda nada
  // en BD. El usuario la dispara desde el semáforo sobre la constancia ya en disco.
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_vencimiento_tributario')
  @Post('extraer')
  extraer(@Body() dto: ExtraerConstanciaDto) {
    return this.extraccionService.extraer(dto.ruta);
  }

  @RequirePermissions('VENCIMIENTOS_LABORAL', 'ver_vencimiento_laboral')
  @Post('laboral/extraer')
  extraerLaboral(@Body() dto: ExtraerConstanciaDto) {
    return this.extraccionService.extraer(dto.ruta);
  }
}

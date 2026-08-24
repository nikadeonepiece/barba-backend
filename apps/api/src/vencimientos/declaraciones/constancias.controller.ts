import { Controller, Post, Get, Query, Body, Res, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { existsSync, mkdirSync, createReadStream } from 'fs';
import type { Response } from 'express';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { ConstanciasExtraccionService } from './constancias-extraccion.service';
import { ExtraerConstanciaDto } from './dto/extraer-constancia.dto';

// ⚠️ Carpeta PRIVADA, no `uploads/` — ver comentario en constancias-extraccion.service.ts.
const CARPETA_CONSTANCIAS = 'storage-privado/constancias';

const CONFIG_SUBIDA = {
  storage: diskStorage({
    // multer no crea la carpeta: si no existe, toda subida falla con ENOENT.
    destination: (_req: any, _file: any, cb: any) => {
      if (!existsSync(CARPETA_CONSTANCIAS)) mkdirSync(CARPETA_CONSTANCIAS, { recursive: true });
      cb(null, CARPETA_CONSTANCIAS);
    },
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
 * Subida de constancias de declaración (PDF). Se guarda en disco local en la
 * carpeta PRIVADA `storage-privado/constancias` (NO en `uploads/`, que main.ts
 * publica estática y sin login) y se devuelve la ruta relativa
 * `/constancias/<archivo>` para guardarla en `declaracion.constancia_archivo`.
 * Para verla se usa `GET /vencimientos/constancias/archivo?ruta=...`, con guard.
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
    return { success: true, ruta: `/constancias/${archivo.filename}` };
  }

  // Mismo almacenamiento, permiso laboral — sin este endpoint, un usuario con solo
  // VENCIMIENTOS_LABORAL no puede subir la constancia de Planilla/AFP.
  @RequirePermissions('VENCIMIENTOS_LABORAL', 'marcar_declaracion_laboral')
  @Post('laboral/subir')
  @UseInterceptors(FileInterceptor('archivo', CONFIG_SUBIDA))
  subirLaboral(@UploadedFile() archivo: Express.Multer.File) {
    if (!archivo) throw new BadRequestException('No se recibió ningún archivo');
    return { success: true, ruta: `/constancias/${archivo.filename}` };
  }

  // Servido con guard, nunca por la ruta estática pública `/uploads/`: el PDF de una
  // constancia es el documento tributario del cliente. `@Res()` SIN `passthrough`
  // (mismo patrón que la descarga SIRE): con `passthrough: true` el
  // TransformInterceptor se sigue aplicando y envolvería el binario en el JSON
  // `{ success, data }`, rompiendo la descarga.
  @RequirePermissions('VENCIMIENTOS_TRIBUTARIO', 'ver_vencimiento_tributario')
  @Get('archivo')
  verArchivo(@Query('ruta') ruta: string, @Res() res: Response) {
    this.enviarPdf(ruta, res);
  }

  @RequirePermissions('VENCIMIENTOS_LABORAL', 'ver_vencimiento_laboral')
  @Get('laboral/archivo')
  verArchivoLaboral(@Query('ruta') ruta: string, @Res() res: Response) {
    this.enviarPdf(ruta, res);
  }

  // Stream, no `readFileSync`: el hosting es compartido y cargar el PDF entero en RAM
  // por cada usuario que abre una constancia tumba el proceso (ver CLAUDE.md).
  private enviarPdf(ruta: string, res: Response) {
    if (!ruta) throw new BadRequestException('Falta la ruta de la constancia');
    // Valida el nombre y confirma que exista (lanza 400/404 con mensaje claro).
    const rutaAbsoluta = this.extraccionService.resolverRutaSegura(ruta);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${rutaAbsoluta.split(/[\\/]/).pop()}"`);
    const stream = createReadStream(rutaAbsoluta);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ mensaje: 'El archivo de la constancia ya no existe en el servidor' });
      else res.end();
    });
    stream.pipe(res);
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

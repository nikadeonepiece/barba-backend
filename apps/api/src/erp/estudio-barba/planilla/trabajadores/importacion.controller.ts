import {
  Controller, Post, Get, Body, Query, UseGuards, UseInterceptors, UploadedFile, Req, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard, PermissionsGuard, RequirePermissions } from '@app/auth';
import { ImportacionTrabajadoresService } from './importacion.service';
import { ConfirmarImportacionDto } from './dto/importacion.dto';

/**
 * El archivo se procesa EN MEMORIA y no se guarda en disco (`memoryStorage`).
 *
 * A diferencia de las constancias PDF —que son el respaldo de una declaración y hay
 * que conservarlas—, este Excel es solo un vehículo: lo que importa son los
 * trabajadores creados. Guardarlo dejaría archivos con datos personales de terceros
 * acumulándose sin que nadie los vuelva a abrir.
 *
 * El límite de 10 MB es holgado para un padrón (cientos de filas) y evita que alguien
 * suba un libro de 200 MB y tumbe el proceso de Node: el hosting es compartido y con
 * RAM limitada (ver la regla de memoria en CLAUDE.md).
 */
const CONFIG_SUBIDA = {
  storage: memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (!/\.xlsx$/i.test(file.originalname)) {
      // Se rechaza .xls a propósito: ExcelJS solo lee el formato nuevo, y fallar acá
      // con un mensaje claro es mejor que reventar al parsear.
      return cb(new BadRequestException('Solo se aceptan archivos .xlsx. Si el tuyo es .xls, ábrelo en Excel y guárdalo como .xlsx.'), false);
    }
    cb(null, true);
  },
};

@Controller('planilla/trabajadores/importar')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ImportacionTrabajadoresController {
  constructor(private readonly service: ImportacionTrabajadoresService) {}

  @RequirePermissions('PLANILLA', 'crear_trabajador')
  @Get('campos')
  camposImportables() {
    return this.service.camposImportables();
  }

  /** Paso 1: leer el archivo y devolver columnas y filas, sin crear nada. */
  @RequirePermissions('PLANILLA', 'crear_trabajador')
  @Post('analizar')
  @UseInterceptors(FileInterceptor('archivo', CONFIG_SUBIDA))
  analizar(@UploadedFile() archivo: Express.Multer.File, @Query('hoja') hoja?: string) {
    if (!archivo) throw new BadRequestException('No se recibió ningún archivo');
    return this.service.analizar(archivo.buffer, hoja);
  }

  /** Paso 2: crear los trabajadores con el mapeo que confirmó el usuario. */
  @RequirePermissions('PLANILLA', 'crear_trabajador')
  @Post('confirmar')
  confirmar(@Body() dto: ConfirmarImportacionDto, @Req() req: any) {
    return this.service.confirmar(dto, req.user.userId);
  }
}

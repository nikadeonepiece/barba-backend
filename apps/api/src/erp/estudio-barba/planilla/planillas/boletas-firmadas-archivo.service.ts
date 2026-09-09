import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { diskStorage } from 'multer';
import { extname, resolve } from 'path';
import { existsSync, mkdirSync, createReadStream, statSync, unlinkSync } from 'fs';
import type { Response } from 'express';

/**
 * Carpeta PRIVADA, NO `uploads/`.
 *
 * `main.ts` publica `uploads/` como estático y SIN login: cualquiera con la URL baja
 * el archivo. Una boleta firmada trae sueldo, DNI y la firma del trabajador — se
 * sirve solo por endpoint con guard, igual que los contratos
 * (`planilla/contratos/contratos-archivo.service.ts`, mismo criterio).
 */
export const CARPETA_BOLETAS_FIRMADAS = resolve(process.cwd(), 'storage-privado', 'boletas-firmadas');

/**
 * Config de multer del endpoint de subida.
 *
 * Va acá y no en el controller para que exista UN solo lugar que decida dónde caen
 * los archivos: el día que esto pase a S3, se cambia una constante.
 */
export const CONFIG_SUBIDA_BOLETA_FIRMADA = {
  storage: diskStorage({
    // multer NO crea la carpeta: si no existe, toda subida falla con ENOENT.
    destination: (_req: any, _file: any, cb: any) => {
      if (!existsSync(CARPETA_BOLETAS_FIRMADAS)) mkdirSync(CARPETA_BOLETAS_FIRMADAS, { recursive: true });
      cb(null, CARPETA_BOLETAS_FIRMADAS);
    },
    // Nombre aleatorio, no el original: dos empresas escanean "boleta.pdf" el mismo
    // día y el segundo pisaría al primero sin ningún aviso. El nombre que ve el
    // usuario se guarda aparte, en `planilla_boleta_firmada.archivo_nombre`.
    filename: (_req: any, file: any, cb: any) => {
      const sufijo = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `boleta-firmada-${sufijo}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new BadRequestException('Solo se aceptan archivos PDF'), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — una boleta escaneada no pasa de ahí
};

/**
 * Todo lo que toca el DISCO para las boletas firmadas: validar la ruta, medir el
 * archivo, enviarlo y borrarlo.
 *
 * Provider aparte y exportado porque lo usan DOS módulos con permisos distintos: la
 * pantalla del estudio (`planilla/planillas`) y —cuando se habilite— el portal
 * cliente. Duplicar `resolverRutaSegura` sería duplicar el control anti-traversal, y
 * el día que se corrija en uno el otro queda abierto.
 */
@Injectable()
export class BoletasFirmadasArchivoService {
  /**
   * Convierte la ruta relativa guardada en BD (`/boletas-firmadas/archivo.pdf`) en una
   * ruta absoluta de disco, o falla.
   *
   * Se queda SOLO con el nombre del archivo y lo vuelve a resolver contra la carpeta:
   * así una ruta como `../../.env` no puede salir de `storage-privado/boletas-firmadas`
   * por más que alguien la mande a mano.
   */
  resolverRutaSegura(rutaRelativa: string): string {
    const nombreArchivo = String(rutaRelativa || '').split(/[\/]/).pop()?.trim() || '';
    if (!nombreArchivo || nombreArchivo.includes('..')) {
      throw new BadRequestException('Ruta de archivo inválida');
    }

    const rutaAbsoluta = resolve(CARPETA_BOLETAS_FIRMADAS, nombreArchivo);
    if (!rutaAbsoluta.startsWith(CARPETA_BOLETAS_FIRMADAS)) {
      throw new BadRequestException('Ruta de archivo inválida');
    }
    if (!existsSync(rutaAbsoluta)) {
      throw new NotFoundException('El PDF de la boleta firmada ya no existe en el servidor');
    }
    return rutaAbsoluta;
  }

  /**
   * Tamaño real en disco. Se mide acá en vez de creerle al frontend: el `size` que
   * devuelve la subida podría venir alterado en el POST siguiente, y lo que se muestra
   * en pantalla dejaría de coincidir con lo que el usuario va a descargar.
   */
  tamanoReal(rutaRelativa: string): number {
    return statSync(this.resolverRutaSegura(rutaRelativa)).size;
  }

  /**
   * Manda el PDF al navegador como descarga.
   *
   * Stream, nunca `readFileSync`: el hosting es compartido y cargar cada PDF entero en
   * RAM por cada usuario que descarga tumba el proceso (regla de memoria de CLAUDE.md).
   */
  enviarPdf(rutaRelativa: string, nombreDescarga: string, res: Response) {
    const rutaAbsoluta = this.resolverRutaSegura(rutaRelativa);
    const nombre = (nombreDescarga || 'boleta-firmada.pdf').replace(/[^\w.\- ]+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);

    const stream = createReadStream(rutaAbsoluta);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ mensaje: 'El PDF de la boleta firmada ya no existe en el servidor' });
      else res.end();
    });
    stream.pipe(res);
  }

  /**
   * Borra el PDF de disco. Se usa en dos casos: la subida quedó huérfana (el archivo
   * entró pero el INSERT falló) y el reemplazo (se subió un escaneo nuevo sobre uno
   * anterior). Sin esto, cada error deja un PDF con datos personales tirado en el
   * servidor y nadie lo vuelve a mirar.
   *
   * Traga el error a propósito: si el borrado falla, el problema real es el de la
   * operación que ya venía fallando, y tapar esa excepción con una de `unlink` haría
   * el diagnóstico más difícil.
   */
  borrarSiExiste(rutaRelativa: string | null | undefined): void {
    if (!rutaRelativa) return;
    try {
      const nombreArchivo = String(rutaRelativa).split(/[\/]/).pop()?.trim() || '';
      if (!nombreArchivo || nombreArchivo.includes('..')) return;
      const rutaAbsoluta = resolve(CARPETA_BOLETAS_FIRMADAS, nombreArchivo);
      if (rutaAbsoluta.startsWith(CARPETA_BOLETAS_FIRMADAS) && existsSync(rutaAbsoluta)) unlinkSync(rutaAbsoluta);
    } catch (_) {
      /* ver comentario de arriba */
    }
  }
}

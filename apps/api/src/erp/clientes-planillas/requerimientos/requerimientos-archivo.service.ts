import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { diskStorage } from 'multer';
import { extname, resolve } from 'path';
import { existsSync, mkdirSync, createReadStream, unlinkSync } from 'fs';
import type { Response } from 'express';

/**
 * Carpeta PRIVADA, NO `uploads/`.
 *
 * `main.ts` publica `uploads/` como estático y SIN login. La proforma o la factura de
 * un requerimiento trae RUC, razón social y montos de un proveedor de un cliente del
 * estudio, así que se sirve solo por endpoint con guard — mismo criterio que el
 * comprobante de caja chica (`cajas-archivo.service.ts`) y que los contratos.
 */
export const CARPETA_COMPROBANTES_REQ = resolve(process.cwd(), 'storage-privado', 'requerimiento-comprobantes');

const MIMETYPES_PERMITIDOS = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

/**
 * Config de multer. Vive acá y no en el controller para que exista UN solo lugar que
 * decida dónde caen los archivos.
 */
export const CONFIG_SUBIDA_COMPROBANTE_REQ = {
  storage: diskStorage({
    // multer NO crea la carpeta: si no existe, toda subida falla con ENOENT.
    destination: (_req: any, _file: any, cb: any) => {
      if (!existsSync(CARPETA_COMPROBANTES_REQ)) mkdirSync(CARPETA_COMPROBANTES_REQ, { recursive: true });
      cb(null, CARPETA_COMPROBANTES_REQ);
    },
    // Nombre aleatorio y no el original: dos personas suben "foto.jpg" el mismo día y
    // el segundo pisaría al primero sin aviso. El nombre que ve el usuario se guarda
    // aparte, en `requerimiento.nombre_comprobante`.
    filename: (_req: any, file: any, cb: any) => {
      const sufijo = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `req-${sufijo}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  fileFilter: (_req: any, file: any, cb: any) => {
    if (!MIMETYPES_PERMITIDOS.includes(file.mimetype)) {
      return cb(new BadRequestException('El comprobante debe ser un PDF o una imagen PNG, JPG o WEBP'), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
};

const TIPOS_POR_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

@Injectable()
export class RequerimientosArchivoService {
  /**
   * Ruta relativa de BD → ruta absoluta de disco, o falla.
   *
   * Se queda SOLO con el nombre del archivo y lo vuelve a resolver contra la carpeta:
   * así un valor como `../../.env` no puede salir de la carpeta por más que alguien lo
   * mande a mano.
   */
  resolverRutaSegura(rutaRelativa: string): string {
    const nombreArchivo = String(rutaRelativa || '').split(/[\/\\]/).pop()?.trim() || '';
    if (!nombreArchivo || nombreArchivo.includes('..')) {
      throw new BadRequestException('Ruta de archivo inválida');
    }

    const rutaAbsoluta = resolve(CARPETA_COMPROBANTES_REQ, nombreArchivo);
    if (!rutaAbsoluta.startsWith(CARPETA_COMPROBANTES_REQ)) {
      throw new BadRequestException('Ruta de archivo inválida');
    }
    if (!existsSync(rutaAbsoluta)) {
      throw new NotFoundException('El comprobante ya no existe en el servidor');
    }
    return rutaAbsoluta;
  }

  /**
   * Manda el comprobante al navegador por stream, nunca con `readFileSync`: el hosting
   * es compartido y cargar cada archivo entero en RAM tumba el proceso.
   *
   * `inline` y no `attachment`: quien revisa quiere MIRAR la proforma para verificar
   * el monto, no bajarla.
   */
  enviar(rutaRelativa: string, nombreDescarga: string, res: Response) {
    const rutaAbsoluta = this.resolverRutaSegura(rutaRelativa);
    const nombre = (nombreDescarga || 'comprobante').replace(/[^\w.\- ]+/g, '_');
    const tipo = TIPOS_POR_EXTENSION[extname(rutaAbsoluta).toLowerCase()] || 'application/octet-stream';

    res.setHeader('Content-Type', tipo);
    res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);

    const stream = createReadStream(rutaAbsoluta);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ mensaje: 'El comprobante ya no existe en el servidor' });
      else res.end();
    });
    stream.pipe(res);
  }

  /**
   * Borra el archivo de disco: subida huérfana (entró el archivo pero falló el INSERT)
   * o reemplazo del comprobante.
   *
   * Traga el error a propósito: si el borrado falla, el problema real es el de la
   * operación que ya venía fallando.
   */
  borrarSiExiste(rutaRelativa: string | null | undefined): void {
    if (!rutaRelativa) return;
    try {
      const nombreArchivo = String(rutaRelativa).split(/[\/\\]/).pop()?.trim() || '';
      if (!nombreArchivo || nombreArchivo.includes('..')) return;
      const rutaAbsoluta = resolve(CARPETA_COMPROBANTES_REQ, nombreArchivo);
      if (rutaAbsoluta.startsWith(CARPETA_COMPROBANTES_REQ) && existsSync(rutaAbsoluta)) unlinkSync(rutaAbsoluta);
    } catch (_) {
      /* ver comentario de arriba */
    }
  }
}

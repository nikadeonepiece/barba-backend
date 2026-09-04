import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { diskStorage } from 'multer';
import { extname, resolve } from 'path';
import { existsSync, mkdirSync, createReadStream, unlinkSync } from 'fs';
import type { Response } from 'express';

/**
 * Carpeta PRIVADA, NO `uploads/`.
 *
 * `main.ts` publica `uploads/` como estático y SIN login: cualquiera con la URL baja
 * el archivo. El comprobante de un gasto de caja trae el RUC del proveedor, el monto
 * y a veces el nombre de quien compró — es dato de un cliente del estudio, así que se
 * sirve solo por endpoint con guard, igual que los contratos y las constancias
 * (`contratos-archivo.service.ts`, mismo criterio).
 */
export const CARPETA_COMPROBANTES = resolve(process.cwd(), 'storage-privado', 'caja-comprobantes');

/** Lo que se puede adjuntar a un gasto: la foto del ticket o el PDF de la factura. */
const MIMETYPES_PERMITIDOS = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

/**
 * Config de multer del comprobante. Vive acá y no en el controller para que exista UN
 * solo lugar que decida dónde caen los archivos (mismo criterio que
 * `CONFIG_SUBIDA_CONTRATO` y `CONFIG_SUBIDA_LOGO`).
 */
export const CONFIG_SUBIDA_COMPROBANTE = {
  storage: diskStorage({
    // multer NO crea la carpeta: si no existe, toda subida falla con ENOENT.
    destination: (_req: any, _file: any, cb: any) => {
      if (!existsSync(CARPETA_COMPROBANTES)) mkdirSync(CARPETA_COMPROBANTES, { recursive: true });
      cb(null, CARPETA_COMPROBANTES);
    },
    // Nombre aleatorio, no el original: dos cajas suben "foto.jpg" el mismo día y el
    // segundo pisaría al primero sin ningún aviso. El nombre que ve el usuario se
    // guarda aparte, en `caja_chica_movimiento.nombre_comprobante`.
    filename: (_req: any, file: any, cb: any) => {
      const sufijo = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `comprobante-${sufijo}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  fileFilter: (_req: any, file: any, cb: any) => {
    if (!MIMETYPES_PERMITIDOS.includes(file.mimetype)) {
      return cb(new BadRequestException('El comprobante debe ser un PDF o una imagen PNG, JPG o WEBP'), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — una foto de ticket no pasa de ahí
};

/** Content-Type por extensión: sin él el navegador baja todo como binario y no previsualiza nada. */
const TIPOS_POR_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

@Injectable()
export class CajasArchivoService {
  /**
   * Convierte la ruta relativa guardada en BD (`/caja-comprobantes/archivo.pdf`) en
   * una ruta absoluta de disco, o falla.
   *
   * Se queda SOLO con el nombre del archivo y lo vuelve a resolver contra la carpeta:
   * así una ruta como `../../.env` no puede salir de `storage-privado/caja-comprobantes`
   * por más que alguien la mande a mano.
   */
  resolverRutaSegura(rutaRelativa: string): string {
    const nombreArchivo = String(rutaRelativa || '').split(/[\/]/).pop()?.trim() || '';
    if (!nombreArchivo || nombreArchivo.includes('..')) {
      throw new BadRequestException('Ruta de archivo inválida');
    }

    const rutaAbsoluta = resolve(CARPETA_COMPROBANTES, nombreArchivo);
    if (!rutaAbsoluta.startsWith(CARPETA_COMPROBANTES)) {
      throw new BadRequestException('Ruta de archivo inválida');
    }
    if (!existsSync(rutaAbsoluta)) {
      throw new NotFoundException('El comprobante ya no existe en el servidor');
    }
    return rutaAbsoluta;
  }

  /**
   * Manda el comprobante al navegador.
   *
   * Stream, nunca `readFileSync`: el hosting es compartido y cargar cada archivo
   * entero en RAM por cada usuario que descarga tumba el proceso (regla de memoria de
   * CLAUDE.md).
   *
   * `inline` y no `attachment`: el usuario suele querer MIRAR el ticket para
   * verificar el monto, no bajarlo. El navegador igual deja guardarlo desde el visor.
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
   * Borra el archivo de disco. Se usa cuando la subida quedó huérfana (el archivo
   * entró pero el INSERT del movimiento falló) y al reemplazar el comprobante de un
   * movimiento editado.
   *
   * Traga el error a propósito: si el borrado falla, el problema real es el de la
   * operación que ya venía fallando, y taparlo con una excepción de `unlink` haría el
   * diagnóstico más difícil.
   */
  borrarSiExiste(rutaRelativa: string | null | undefined): void {
    if (!rutaRelativa) return;
    try {
      const nombreArchivo = String(rutaRelativa).split(/[\/]/).pop()?.trim() || '';
      if (!nombreArchivo || nombreArchivo.includes('..')) return;
      const rutaAbsoluta = resolve(CARPETA_COMPROBANTES, nombreArchivo);
      if (rutaAbsoluta.startsWith(CARPETA_COMPROBANTES) && existsSync(rutaAbsoluta)) unlinkSync(rutaAbsoluta);
    } catch (_) {
      /* ver comentario de arriba */
    }
  }
}

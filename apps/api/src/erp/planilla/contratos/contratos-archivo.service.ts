import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { diskStorage } from 'multer';
import { extname, resolve } from 'path';
import { existsSync, mkdirSync, createReadStream, statSync, unlinkSync } from 'fs';
import type { Response } from 'express';

/**
 * Carpeta PRIVADA, NO `uploads/`.
 *
 * `main.ts` publica `uploads/` como estático y SIN login: cualquiera con la URL baja
 * el archivo. Un contrato laboral trae DNI, domicilio y sueldo — se sirve solo por
 * endpoint con guard, igual que las constancias de declaración
 * (`vencimientos/declaraciones/constancias.controller.ts`, mismo criterio).
 */
export const CARPETA_CONTRATOS = resolve(process.cwd(), 'storage-privado', 'contratos');

/**
 * Config de multer compartida por el endpoint de subida.
 *
 * Va acá y no en el controller para que exista UN solo lugar que decida dónde caen
 * los archivos: el día que esto pase a S3 o a otra carpeta, se cambia una constante y
 * no hay que acordarse de los dos o tres controllers que la habían copiado.
 */
export const CONFIG_SUBIDA_CONTRATO = {
  storage: diskStorage({
    // multer NO crea la carpeta: si no existe, toda subida falla con ENOENT.
    destination: (_req: any, _file: any, cb: any) => {
      if (!existsSync(CARPETA_CONTRATOS)) mkdirSync(CARPETA_CONTRATOS, { recursive: true });
      cb(null, CARPETA_CONTRATOS);
    },
    // Nombre aleatorio, no el original: dos empresas suben "contrato.pdf" el mismo
    // día y el segundo pisaría al primero sin ningún aviso. El nombre que ve el
    // usuario se guarda aparte, en `planilla_contrato.archivo_nombre`.
    filename: (_req: any, file: any, cb: any) => {
      const sufijo = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `contrato-${sufijo}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new BadRequestException('Solo se aceptan archivos PDF'), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — un contrato escaneado no pasa de ahí
};

/**
 * Todo lo que toca el DISCO para los contratos: validar la ruta, medir el archivo,
 * enviarlo y borrarlo.
 *
 * Existe como provider aparte porque lo usan DOS módulos con permisos distintos: la
 * pantalla del estudio (`planilla/contratos`) y el portal cliente (`cliente/personal`).
 * Duplicar `resolverRutaSegura` en los dos sería duplicar el control anti-traversal, y
 * el día que se corrija en uno el otro queda abierto.
 */
@Injectable()
export class ContratosArchivoService {
  /**
   * Convierte la ruta relativa guardada en BD (`/contratos/archivo.pdf`) en una ruta
   * absoluta de disco, o falla.
   *
   * Se queda SOLO con el nombre del archivo y lo vuelve a resolver contra la carpeta:
   * así una ruta como `../../.env` no puede salir de `storage-privado/contratos` por
   * más que alguien la mande a mano en el query string.
   */
  resolverRutaSegura(rutaRelativa: string): string {
    const nombreArchivo = String(rutaRelativa || '').split(/[\/]/).pop()?.trim() || '';
    if (!nombreArchivo || nombreArchivo.includes('..')) {
      throw new BadRequestException('Ruta de archivo inválida');
    }

    const rutaAbsoluta = resolve(CARPETA_CONTRATOS, nombreArchivo);
    if (!rutaAbsoluta.startsWith(CARPETA_CONTRATOS)) {
      throw new BadRequestException('Ruta de archivo inválida');
    }
    if (!existsSync(rutaAbsoluta)) {
      throw new NotFoundException('El archivo del contrato ya no existe en el servidor');
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
   *
   * `nombreDescarga` es el nombre ORIGINAL guardado en BD, no el aleatorio del disco:
   * al cliente le tiene que llegar "contrato-juan-perez.pdf" y no "contrato-17..-3.pdf".
   */
  enviarPdf(rutaRelativa: string, nombreDescarga: string, res: Response) {
    const rutaAbsoluta = this.resolverRutaSegura(rutaRelativa);
    const nombre = (nombreDescarga || 'contrato.pdf').replace(/[^\w.\- ]+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);

    const stream = createReadStream(rutaAbsoluta);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ mensaje: 'El archivo del contrato ya no existe en el servidor' });
      else res.end();
    });
    stream.pipe(res);
  }

  /**
   * Borra el PDF de disco. Se usa cuando la subida quedó huérfana: el archivo entró
   * pero el INSERT del contrato falló. Sin esto, cada error de validación deja un PDF
   * con datos personales tirado en el servidor y nadie lo vuelve a mirar.
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
      const rutaAbsoluta = resolve(CARPETA_CONTRATOS, nombreArchivo);
      if (rutaAbsoluta.startsWith(CARPETA_CONTRATOS) && existsSync(rutaAbsoluta)) unlinkSync(rutaAbsoluta);
    } catch (_) {
      /* ver comentario de arriba */
    }
  }
}

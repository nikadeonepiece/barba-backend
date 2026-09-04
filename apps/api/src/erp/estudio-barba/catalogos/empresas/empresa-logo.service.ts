import { BadRequestException, Injectable } from '@nestjs/common';
import { diskStorage } from 'multer';
import { extname, resolve } from 'path';
import { existsSync, mkdirSync, unlinkSync } from 'fs';

/**
 * Carpeta PÚBLICA (`uploads/`), al revés que los contratos y las constancias.
 *
 * Es a propósito: el logo de una empresa cliente no es dato sensible y tiene que
 * renderizarse en un `<img>` de la pantalla de detalle sin poder mandarle el JWT.
 * `main.ts` publica `uploads/` bajo el prefijo `/uploads/`, así que la ruta que se
 * guarda en `empresa.logo_url` ya viene con ese prefijo y el frontend solo le
 * antepone `environment.uploadsUrlGestion`.
 *
 * ⚠️ Si algún día acá se guardara algo que no deba verse sin login, va a
 * `storage-privado/` y se sirve por endpoint con guard — como hace
 * `contratos-archivo.service.ts`.
 */
export const CARPETA_LOGOS = resolve(process.cwd(), 'uploads', 'logos-empresa');

/** Formatos que un navegador muestra sin plugins. SVG queda fuera a propósito: es XML y puede traer <script>. */
const MIMETYPES_PERMITIDOS = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Config de multer del logo. Vive acá y no en el controller para que exista UN solo
 * lugar que decida dónde caen los archivos (mismo criterio que `CONFIG_SUBIDA_CONTRATO`).
 */
export const CONFIG_SUBIDA_LOGO = {
  storage: diskStorage({
    // multer NO crea la carpeta: si no existe, toda subida falla con ENOENT.
    destination: (_req: any, _file: any, cb: any) => {
      if (!existsSync(CARPETA_LOGOS)) mkdirSync(CARPETA_LOGOS, { recursive: true });
      cb(null, CARPETA_LOGOS);
    },
    // Nombre con el id de la empresa + sufijo aleatorio. El id ayuda a identificarlo
    // mirando la carpeta; el sufijo evita que al reemplazar el logo el navegador siga
    // mostrando el anterior desde su caché (la URL cambia).
    filename: (req: any, file: any, cb: any) => {
      const idEmpresa = Number(req.params?.id) || 0;
      const sufijo = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `logo-${idEmpresa}-${sufijo}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  fileFilter: (_req: any, file: any, cb: any) => {
    if (!MIMETYPES_PERMITIDOS.includes(file.mimetype)) {
      return cb(new BadRequestException('El logo debe ser una imagen PNG, JPG o WEBP'), false);
    }
    cb(null, true);
  },
  // SIN `limits.fileSize` a propósito: el logo no tiene tope de peso. A diferencia del
  // resto de las subidas del sistema (contratos, constancias, tickets: 10 MB), acá se
  // acepta lo que mande el usuario. Solo se filtra el formato, arriba.
};

@Injectable()
export class EmpresaLogoService {
  /**
   * Borra del disco el logo anterior. Se llama al reemplazarlo y al quitarlo: sin esto
   * cada cambio de logo deja un archivo huérfano en `uploads/` para siempre.
   *
   * Se queda SOLO con el nombre del archivo y lo vuelve a resolver contra la carpeta,
   * para que un `logo_url` manipulado (`../../.env`) no pueda borrar nada de afuera.
   * Traga el error a propósito: que no se pueda borrar el archivo viejo no es motivo
   * para que falle el guardado del nuevo.
   */
  borrarSiExiste(rutaRelativa: string | null | undefined): void {
    if (!rutaRelativa) return;
    try {
      const nombreArchivo = String(rutaRelativa).split(/[\/]/).pop()?.trim() || '';
      if (!nombreArchivo || nombreArchivo.includes('..')) return;
      const rutaAbsoluta = resolve(CARPETA_LOGOS, nombreArchivo);
      if (rutaAbsoluta.startsWith(CARPETA_LOGOS) && existsSync(rutaAbsoluta)) unlinkSync(rutaAbsoluta);
    } catch (_) {
      /* ver comentario de arriba */
    }
  }
}

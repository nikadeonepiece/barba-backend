import { Injectable, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Cifrado de credenciales SUNAT (Clave SOL y client_id/secret de API) a nivel de aplicación.
 * AES-256-GCM: la llave NUNCA vive en la base de datos, solo en la variable de entorno
 * CREDENCIALES_ENCRYPTION_KEY (32 bytes, generar una vez con: openssl rand -hex 32 y
 * convertir a base64, o directamente `openssl rand -base64 32`).
 *
 * Formato guardado: iv (12 bytes) + authTag (16 bytes) + ciphertext, todo en un solo buffer.
 */
@Injectable()
export class CredencialesCryptoService implements OnModuleInit {
  private key!: Buffer;

  onModuleInit() {
    const keyB64 = process.env.CREDENCIALES_ENCRYPTION_KEY;
    if (!keyB64) {
      throw new InternalServerErrorException(
        'Falta la variable de entorno CREDENCIALES_ENCRYPTION_KEY (32 bytes en base64) para cifrar credenciales SUNAT.',
      );
    }
    this.key = Buffer.from(keyB64, 'base64');
    if (this.key.length !== 32) {
      throw new InternalServerErrorException('CREDENCIALES_ENCRYPTION_KEY debe decodificar a exactamente 32 bytes.');
    }
  }

  cifrar(textoPlano: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  descifrar(datoCifrado: Buffer): string {
    const iv = datoCifrado.subarray(0, 12);
    const authTag = datoCifrado.subarray(12, 28);
    const ciphertext = datoCifrado.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

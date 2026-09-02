import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const secret = config.get<string>('JWT_SECRET');
    // Sin fallback: un secreto adivinable ('emergencia') permite forjar tokens válidos
    // para cualquier usuario/rol — si falta la variable de entorno, el arranque debe fallar,
    // no arrancar en un estado inseguro.
    if (!secret) throw new InternalServerErrorException('Falta la variable de entorno JWT_SECRET');

    super({
      // Le decimos que busque la "pulsera" en el Header de la petición HTTP (Bearer Token)
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false, // Si el token caducó, rechaza el acceso automáticamente
      secretOrKey: secret, // La firma criptográfica
    });
  }

  // Si el token es real y no ha caducado, esta función extrae los datos del usuario
  // para que podamos usarlos dentro de nuestra API (ej: saber quién está creando un producto).
  //
  // `idEmpresa` es el scope del PORTAL CLIENTE: sale de `sis_usuario.id_empresa` y es
  // lo que los services de `erp/cliente/` meten en el WHERE de cada consulta. Se lee
  // del TOKEN y nunca del body/query — si viniera del frontend, cambiar un número en
  // la petición dejaría ver la planilla de otra empresa.
  //
  // `null` para el personal del estudio (no está atado a ninguna empresa). Se
  // normaliza acá y no en cada service: un token viejo, firmado antes de que existiera
  // la columna, no trae el campo, y `undefined` colándose hasta un array de params de
  // MySQL no falla — devuelve 0 filas y parece "sin datos" en vez de un error.
  async validate(payload: any) {
    return {
      userId: payload.sub,
      email: payload.username,
      roleId: payload.roleId,
      idEmpresa: payload.idEmpresa ?? null,
    };
  }
}
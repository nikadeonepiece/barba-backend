import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes, createHash } from 'crypto';
import { UsuariosService } from '../usuarios/usuarios.service';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';

const REFRESH_TOKEN_BYTES = 64;

// Margen para refrescos casi simultáneos (dos pestañas cuyo access token expira
// junto, o una pantalla que dispara varias peticiones a la vez). Sin esto la
// segunda llamada llega con el token que la primera acaba de rotar, no lo
// encuentra vigente y cierra la sesión sin motivo real. Dentro de esta ventana
// se sigue la cadena de reemplazos — ver resolverPorReemplazoReciente().
const GRACE_SEGUNDOS = 15;

// Tope de saltos al seguir la cadena de reemplazos: evita un bucle infinito si
// los datos quedaran inconsistentes.
const MAX_SALTOS_CADENA = 5;

@Injectable()
export class AuthService {
  constructor(
    private readonly usuariosService: UsuariosService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
  ) {}

  private hashToken(tokenPlano: string): string {
    return createHash('sha256').update(tokenPlano).digest('hex');
  }

  /**
   * Emite un refresh token nuevo. Devuelve también su id porque al rotar hay que
   * dejar apuntado en el token viejo cuál lo reemplazó (`reemplazado_por`).
   * `ip` y `userAgent` son opcionales: si el controller no los pasa, quedan en
   * NULL y el resto sigue funcionando igual.
   */
  private async emitirRefreshToken(
    idUsuario: number,
    ip: string | null = null,
    userAgent: string | null = null,
  ): Promise<{ tokenPlano: string; id: number }> {
    const tokenPlano = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const dias = Number(this.configService.get<string>('REFRESH_TOKEN_EXPIRES_DAYS')) || 30;
    const resultado = await this.dataSource.query(
      `INSERT INTO auth_refresh_tokens (id_usuario, token_hash, fecha_expira, ip_origen, user_agent)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?, ?)`,
      [idUsuario, this.hashToken(tokenPlano), dias, ip, userAgent?.slice(0, 255) ?? null],
    );
    return { tokenPlano, id: resultado.insertId };
  }

  /**
   * El token que llegó no está vigente por su propio hash, pero puede haber sido
   * rotado hace apenas unos segundos por otra petición concurrente. En ese caso
   * se sigue la cadena `reemplazado_por` hasta dar con el token vigente actual.
   *
   * Solo se acepta si la revocación fue DENTRO de la ventana de gracia: pasado
   * ese margen, un token ya rotado que reaparece es señal de reuso (robo), no de
   * concurrencia, y debe fallar.
   */
  private async resolverPorReemplazoReciente(tokenHash: string) {
    const [origen] = await this.dataSource.query(
      `SELECT reemplazado_por FROM auth_refresh_tokens
       WHERE token_hash = ? AND revocado = 1 AND reemplazado_por IS NOT NULL
         AND fecha_revocado > (NOW() - INTERVAL ? SECOND)`,
      [tokenHash, GRACE_SEGUNDOS],
    );
    if (!origen) return null;

    let idActual = origen.reemplazado_por;
    for (let salto = 0; salto < MAX_SALTOS_CADENA && idActual; salto++) {
      const [fila] = await this.dataSource.query(
        `SELECT id_refresh_token, id_usuario, revocado, reemplazado_por, fecha_expira
         FROM auth_refresh_tokens WHERE id_refresh_token = ?`,
        [idActual],
      );
      if (!fila) return null;
      if (!fila.revocado && new Date(fila.fecha_expira) > new Date()) return fila; // vigente
      if (!fila.reemplazado_por) return null; // revocado y sin sucesor: cadena rota
      idActual = fila.reemplazado_por;
    }
    return null;
  }

  private firmarAccessToken(user: { id_usuario: number; correo: string; id_rol: number }) {
    return this.jwtService.sign({ sub: user.id_usuario, username: user.correo, roleId: user.id_rol });
  }

  async login(loginDto: LoginDto, ip: string | null = null, userAgent: string | null = null) {
    const user = await this.usuariosService.findByEmail(loginDto.correo);

    if (!user || user.estado_registro !== 'ACTIVO') {
      throw new UnauthorizedException('Credenciales incorrectas o usuario inactivo');
    }

    const passwordValida = await bcrypt.compare(loginDto.password, user.password);

    if (!passwordValida) {
      throw new UnauthorizedException('Credenciales incorrectas');
    }

    let esPrimeraSesion = false;
    try { esPrimeraSesion = await this.usuariosService.leerYMarcarPrimeraSesion(user.id_usuario); } catch (_) {}

    const { tokenPlano: refreshTokenPlano } = await this.emitirRefreshToken(user.id_usuario, ip, userAgent);

    return {
      mensaje: 'Login exitoso',
      access_token: this.firmarAccessToken(user),
      refreshTokenPlano, // el controller lo saca del body y lo manda solo como cookie httpOnly
      primera_sesion: esPrimeraSesion,
      usuario: {
        id_usuario: user.id_usuario,
        nombres: user.nombres,
        apellidos: user.apellidos,
        correo: user.correo,
        id_rol: user.id_rol,
        nombre_rol: user.rol
      }
    };
  }

  // Rota el refresh token: revoca el usado y emite uno nuevo. Si alguien reutiliza
  // un refresh token robado que ya fue usado, esta consulta no lo encuentra (ya está
  // revocado) y falla — eso es lo que detecta el robo/reuso.
  async refresh(refreshTokenPlano: string | undefined, ip: string | null = null, userAgent: string | null = null) {
    if (!refreshTokenPlano) throw new UnauthorizedException('Sesión expirada, vuelve a iniciar sesión');

    const tokenHash = this.hashToken(refreshTokenPlano);
    let registro = (
      await this.dataSource.query(
        `SELECT id_refresh_token, id_usuario FROM auth_refresh_tokens WHERE token_hash = ? AND revocado = 0 AND fecha_expira > NOW()`,
        [tokenHash],
      )
    )[0];

    // No vigente por su propio hash: puede que otra petición concurrente lo haya
    // rotado hace instantes. Dentro de la ventana de gracia se sigue la cadena en
    // vez de cerrar la sesión.
    if (!registro) registro = await this.resolverPorReemplazoReciente(tokenHash);

    if (!registro) throw new UnauthorizedException('Sesión expirada, vuelve a iniciar sesión');

    const user = await this.usuariosService.findOne(registro.id_usuario).catch(() => null);
    if (!user || user.data.estado_registro !== 'ACTIVO') {
      throw new UnauthorizedException('Sesión expirada, vuelve a iniciar sesión');
    }

    const { tokenPlano: nuevoRefreshTokenPlano, id: idNuevo } = await this.emitirRefreshToken(
      registro.id_usuario,
      ip,
      userAgent,
    );

    // Se deja `fecha_revocado` y `reemplazado_por` para que la próxima petición
    // concurrente pueda resolverse por la cadena en vez de perder la sesión.
    await this.dataSource.query(
      `UPDATE auth_refresh_tokens SET revocado = 1, fecha_revocado = NOW(), reemplazado_por = ? WHERE id_refresh_token = ?`,
      [idNuevo, registro.id_refresh_token],
    );

    return {
      access_token: this.firmarAccessToken({ id_usuario: user.data.id_usuario, correo: user.data.correo, id_rol: user.data.id_rol }),
      refreshTokenPlano: nuevoRefreshTokenPlano,
    };
  }

  async logout(refreshTokenPlano: string | undefined) {
    if (!refreshTokenPlano) return;
    // Sin `reemplazado_por`: un logout cierra la cadena, no la continúa. Así el
    // token no puede resolverse por la ventana de gracia después de cerrar sesión.
    await this.dataSource.query(
      `UPDATE auth_refresh_tokens SET revocado = 1, fecha_revocado = NOW() WHERE token_hash = ?`,
      [this.hashToken(refreshTokenPlano)],
    );
  }
}
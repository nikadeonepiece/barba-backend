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

@Injectable()
export class AuthService {
  constructor(
    private readonly usuariosService: UsuariosService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectDataSource('DENTAONEPIECE_CONN') private dataSource: DataSource,
  ) {}

  private hashToken(tokenPlano: string): string {
    return createHash('sha256').update(tokenPlano).digest('hex');
  }

  private async emitirRefreshToken(idUsuario: number): Promise<string> {
    const tokenPlano = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const dias = Number(this.configService.get<string>('REFRESH_TOKEN_EXPIRES_DAYS')) || 30;
    await this.dataSource.query(
      `INSERT INTO auth_refresh_tokens (id_usuario, token_hash, fecha_expira) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [idUsuario, this.hashToken(tokenPlano), dias],
    );
    return tokenPlano;
  }

  private firmarAccessToken(user: { id_usuario: number; correo: string; id_rol: number }) {
    return this.jwtService.sign({ sub: user.id_usuario, username: user.correo, roleId: user.id_rol });
  }

  async login(loginDto: LoginDto) {
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

    const refreshTokenPlano = await this.emitirRefreshToken(user.id_usuario);

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
  async refresh(refreshTokenPlano: string | undefined) {
    if (!refreshTokenPlano) throw new UnauthorizedException('Sesión expirada, vuelve a iniciar sesión');

    const tokenHash = this.hashToken(refreshTokenPlano);
    const [registro] = await this.dataSource.query(
      `SELECT id_refresh_token, id_usuario FROM auth_refresh_tokens WHERE token_hash = ? AND revocado = 0 AND fecha_expira > NOW()`,
      [tokenHash],
    );
    if (!registro) throw new UnauthorizedException('Sesión expirada, vuelve a iniciar sesión');

    const user = await this.usuariosService.findOne(registro.id_usuario).catch(() => null);
    if (!user || user.data.estado_registro !== 'ACTIVO') {
      throw new UnauthorizedException('Sesión expirada, vuelve a iniciar sesión');
    }

    await this.dataSource.query(`UPDATE auth_refresh_tokens SET revocado = 1 WHERE id_refresh_token = ?`, [registro.id_refresh_token]);
    const nuevoRefreshTokenPlano = await this.emitirRefreshToken(registro.id_usuario);

    return {
      access_token: this.firmarAccessToken({ id_usuario: user.data.id_usuario, correo: user.data.correo, id_rol: user.data.id_rol }),
      refreshTokenPlano: nuevoRefreshTokenPlano,
    };
  }

  async logout(refreshTokenPlano: string | undefined) {
    if (!refreshTokenPlano) return;
    await this.dataSource.query(`UPDATE auth_refresh_tokens SET revocado = 1 WHERE token_hash = ?`, [this.hashToken(refreshTokenPlano)]);
  }
}
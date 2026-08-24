import { Controller, Post, Body, Req, Res, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LoginThrottlerGuard } from '@app/security';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

const NOMBRE_COOKIE_REFRESH = 'refresh_token';
const OPCIONES_COOKIE_REFRESH = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

// La app movil (erp-app, Flutter) no puede usar la cookie httpOnly: no hay navegador
// que la administre y guardarla a mano seria menos seguro que el Keystore/Keychain
// del sistema operativo. Por eso el cliente movil se identifica con este header y
// recibe/envia el refresh token por el body y por 'x-refresh-token'.
// El frontend web sigue usando la cookie exactamente igual que antes.
const HEADER_CLIENTE = 'x-client';
const HEADER_REFRESH = 'x-refresh-token';
const CLIENTE_MOVIL = 'mobile';

const esClienteMovil = (req: Request): boolean =>
  req.headers[HEADER_CLIENTE] === CLIENTE_MOVIL;

// El movil manda el refresh token por header; el web, por cookie httpOnly.
const leerRefreshToken = (req: Request): string | undefined =>
  (req.headers[HEADER_REFRESH] as string | undefined) ?? req.cookies?.[NOMBRE_COOKIE_REFRESH];

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Fuerza bruta: 6 intentos por minuto POR CUENTA (correo+IP), no por IP suelta —
  // ver LoginThrottlerGuard. Con el conteo por IP, toda la oficina compartía el mismo
  // cupo (salen por una sola IP pública) y la 6.ª persona en entrar a la misma hora
  // recibía 429 con la contraseña correcta.
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const resultado = await this.authService.login(loginDto);
    const { refreshTokenPlano, ...body } = resultado;
    res.cookie(NOMBRE_COOKIE_REFRESH, refreshTokenPlano, {
      ...OPCIONES_COOKIE_REFRESH,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    return esClienteMovil(req) ? { ...body, refresh_token: refreshTokenPlano } : body;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const resultado = await this.authService.refresh(leerRefreshToken(req));
    const { refreshTokenPlano, ...body } = resultado;
    res.cookie(NOMBRE_COOKIE_REFRESH, refreshTokenPlano, {
      ...OPCIONES_COOKIE_REFRESH,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    // El refresh token rota en cada uso: el movil necesita el nuevo para la próxima vez.
    return esClienteMovil(req) ? { ...body, refresh_token: refreshTokenPlano } : body;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(leerRefreshToken(req));
    res.clearCookie(NOMBRE_COOKIE_REFRESH, OPCIONES_COOKIE_REFRESH);
    return { mensaje: 'Sesión cerrada' };
  }
}

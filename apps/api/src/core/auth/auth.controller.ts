import { Controller, Post, Body, Req, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Más estricto que el rate-limit global (10 req/60s vía SecurityModule): el login
  // es el objetivo típico de fuerza bruta, así que aquí se recorta a 5 intentos/min.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const resultado = await this.authService.login(loginDto);
    const { refreshTokenPlano, ...body } = resultado;
    res.cookie(NOMBRE_COOKIE_REFRESH, refreshTokenPlano, {
      ...OPCIONES_COOKIE_REFRESH,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    return body;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const resultado = await this.authService.refresh(req.cookies?.[NOMBRE_COOKIE_REFRESH]);
    const { refreshTokenPlano, ...body } = resultado;
    res.cookie(NOMBRE_COOKIE_REFRESH, refreshTokenPlano, {
      ...OPCIONES_COOKIE_REFRESH,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    return body;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(req.cookies?.[NOMBRE_COOKIE_REFRESH]);
    res.clearCookie(NOMBRE_COOKIE_REFRESH, OPCIONES_COOKIE_REFRESH);
    return { mensaje: 'Sesión cerrada' };
  }
}

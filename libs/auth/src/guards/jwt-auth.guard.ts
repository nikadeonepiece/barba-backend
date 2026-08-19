import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Este decorador protege nuestras rutas. Si lo ponemos encima de un controlador,
// nadie sin un token válido podrá ejecutar ese código.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
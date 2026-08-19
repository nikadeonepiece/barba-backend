import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsuariosModule } from '../usuarios/usuarios.module';
import { AuthModule as SharedAuthModule } from '@app/auth'; 

@Module({
  imports: [
    UsuariosModule,
    SharedAuthModule
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
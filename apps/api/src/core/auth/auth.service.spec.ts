import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { UsuariosService } from '../usuarios/usuarios.service';

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    // AuthService recibe cuatro dependencias por constructor. El spec que
    // genera el CLI de Nest no mockea ninguna, asi que el modulo de test no
    // podia instanciarlo y la suite fallaba antes de correr un solo caso.
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsuariosService, useValue: {} },
        { provide: JwtService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => undefined } },
        // Token de la conexion nombrada que usa @InjectDataSource.
        { provide: getDataSourceToken('ESTUDIOBARBA_CONN'), useValue: {} },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

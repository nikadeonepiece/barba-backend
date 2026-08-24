import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    // Dos piezas que el spec generado por el CLI no contemplaba:
    // 1. AuthService, que el controller recibe por constructor.
    // 2. ThrottlerModule, porque el controller usa LoginThrottlerGuard y ese
    //    guard depende de THROTTLER:MODULE_OPTIONS. Sin el modulo importado,
    //    Nest no puede construir el guard y la suite falla al compilar.
    const module: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }])],
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: {} }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

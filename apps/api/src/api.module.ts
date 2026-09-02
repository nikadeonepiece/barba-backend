import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '@app/database';
import { SecurityModule } from '@app/security';
import { AuditoriaModule } from '@app/common';
import { AuthModule as SharedAuthModule } from '@app/auth';

import { ApiController } from './api.controller';
import { ApiService } from './api.service';

// --- Módulos Core (Tu base sólida y reutilizable) ---
import { SeguridadModule } from './core/seguridad/seguridad.module';
import { UsuariosModule } from './core/usuarios/usuarios.module';
import { MailModule } from './core/mail/mail.module';
import { AuthModule as LocalAuthModule } from './core/auth/auth.module';

// --- Módulos de negocio: Vencimientos (Fase 1 + Fase 2) ---
import { VencimientosModule } from './erp/vencimientos/vencimientos.module';
import { ConfiguracionesModule } from './erp/configuracion/configuraciones.module';
import { PlanillaModule } from './erp/planilla/planilla.module';

// --- Portal del cliente: la empresa entra a ver SU personal y SUS planillas ---
import { ClienteModule } from './erp/cliente/cliente.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    SharedAuthModule,
    SecurityModule,
    AuditoriaModule,
    LocalAuthModule,
    UsuariosModule,
    SeguridadModule,
    MailModule,
    VencimientosModule,
    ConfiguracionesModule,
    PlanillaModule,
    ClienteModule,
  ],
  controllers: [ApiController],
  providers: [ApiService],
})
export class ApiModule { }

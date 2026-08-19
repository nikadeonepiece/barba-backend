export * from './auth.module';
export * from './guards/jwt-auth.guard';
export * from './strategies/jwt.strategy';
// Agregamos las dos nuevas líneas:
export * from './decorators/require-permissions.decorator';
export * from './guards/permissions.guard';
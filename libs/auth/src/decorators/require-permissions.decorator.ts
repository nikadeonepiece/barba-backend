import { SetMetadata } from '@nestjs/common';

// Definimos una constante para no equivocarnos al escribir el nombre de la metadata
export const PERMISSIONS_KEY = 'permisos_requeridos';

// Este decorador recibirá dos palabras: el módulo y la acción
export const RequirePermissions = (modulo: string, accion: string) => 
  SetMetadata(PERMISSIONS_KEY, { modulo, accion });
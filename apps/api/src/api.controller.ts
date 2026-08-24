import { Controller, Get } from '@nestjs/common';
import { ApiService } from './api.service';

@Controller()
export class ApiController {
  constructor(private readonly apiService: ApiService) {}

  @Get()
  getHello(): string {
    return this.apiService.getHello();
  }

  // Sin guard y sin tocar la BD (CLAUDE.md §4): sirve para que el monitoreo del
  // hosting/uptime sepa si el proceso Node sigue vivo. Si consultara la BD, una
  // caída de MariaDB haría reiniciar el proceso sano en loop.
  @Get('health')
  health() {
    return { estado: 'ok', hora: new Date().toISOString(), uptime_segundos: Math.round(process.uptime()) };
  }
}

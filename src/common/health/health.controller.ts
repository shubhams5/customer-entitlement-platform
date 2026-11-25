import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../prisma/prisma.module';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async checkHealth() {
    await this.prisma.$queryRawUnsafe('SELECT 1;');
    return {
      status: 'ok' as const,
      database: 'up' as const,
      timestamp: new Date().toISOString(),
    };
  }
}

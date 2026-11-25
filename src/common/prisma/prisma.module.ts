import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';
import { resolveSqliteFileUrl } from './sqlite-url';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = resolveSqliteFileUrl(process.env.DATABASE_URL);
    const adapter = new PrismaLibSQL({ url });
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
    await this.$executeRawUnsafe('PRAGMA busy_timeout = 5000;');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { IntegrationsService } from '../src/modules/integrations/integrations.module';

async function seed(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { logger: ['error', 'warn'] },
  );
  await app.init();

  try {
    const integrations = app.get(IntegrationsService);
    const result = await integrations.syncFixtures(
      { fixturesDir: 'fixtures' },
      {
        actorId: 'cli-seed',
        scopes: ['integrations:write'],
        traceId: 'seed_bootstrap',
      },
    );
    process.stdout.write(
      `Seeded SQLite database from JSON/XML/CSV fixtures:\n${JSON.stringify(result, null, 2)}\n`,
    );
  } finally {
    await app.close();
  }
}

seed().catch((err) => {
  process.stderr.write(`Seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

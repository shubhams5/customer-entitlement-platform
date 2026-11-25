import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.module';
import { IntegrationsService } from '../src/modules/integrations/integrations.module';

interface AssignmentCaseFixture {
  id: string;
  caseNumber: string;
  accountId: string;
  severity: string;
  status: string;
  openedAt: string;
  fixtureOnlyFields: {
    entitledSupportLevel: string;
    slaResponseDueAt: string;
    requesterEmail: string;
    subject: string;
    description: string;
  };
}

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
    const assignmentResult = await integrations.syncFixtures(
      { fixturesDir: 'fixtures/assignment-demo' },
      {
        actorId: 'cli-seed',
        scopes: ['integrations:write'],
        traceId: 'seed_assignment_demo',
      },
    );
    const assignmentCase = JSON.parse(
      readFileSync(resolve(process.cwd(), 'fixtures/assignment-demo/case.json'), 'utf8'),
    ) as AssignmentCaseFixture;
    const openedAt = new Date(assignmentCase.openedAt);
    const slaResponseDueAt = new Date(assignmentCase.fixtureOnlyFields.slaResponseDueAt);
    if (Number.isNaN(openedAt.getTime()) || Number.isNaN(slaResponseDueAt.getTime())) {
      throw new Error('Assignment case fixture contains an invalid timestamp.');
    }
    const prisma = app.get(PrismaService);
    const entitlement = await prisma.entitlement.findUnique({
      where: { externalId: 'ent_assignment_demo_acc007' },
    });
    if (!entitlement) {
      throw new Error('Assignment entitlement was not seeded.');
    }
    await prisma.supportCase.upsert({
      where: { id: assignmentCase.id },
      create: {
        id: assignmentCase.id,
        caseNumber: assignmentCase.caseNumber,
        accountId: assignmentCase.accountId,
        entitlementId: entitlement.id,
        severity: assignmentCase.severity,
        status: assignmentCase.status,
        resolvedAt: null,
        escalatedAt: null,
        escalationReason: null,
        version: 1,
        createdAt: openedAt,
        updatedAt: openedAt,
        slaResponseDueAt,
        entitledSupportLevel: assignmentCase.fixtureOnlyFields.entitledSupportLevel,
        requesterEmail: assignmentCase.fixtureOnlyFields.requesterEmail,
        subject: assignmentCase.fixtureOnlyFields.subject,
        description: assignmentCase.fixtureOnlyFields.description,
      },
      update: {
        caseNumber: assignmentCase.caseNumber,
        accountId: assignmentCase.accountId,
        entitlementId: entitlement.id,
        severity: assignmentCase.severity,
        status: assignmentCase.status,
        resolvedAt: null,
        escalatedAt: null,
        escalationReason: null,
        version: 1,
        createdAt: openedAt,
        updatedAt: openedAt,
        slaResponseDueAt,
        entitledSupportLevel: assignmentCase.fixtureOnlyFields.entitledSupportLevel,
        requesterEmail: assignmentCase.fixtureOnlyFields.requesterEmail,
        subject: assignmentCase.fixtureOnlyFields.subject,
        description: assignmentCase.fixtureOnlyFields.description,
      },
    });
    process.stdout.write(
      `Seeded SQLite database from JSON/XML/CSV fixtures:\n${JSON.stringify({
        standard: result,
        assignmentDemo: assignmentResult,
        assignmentCaseId: assignmentCase.id,
      }, null, 2)}\n`,
    );
  } finally {
    await app.close();
  }
}

seed().catch((err) => {
  process.stderr.write(`Seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

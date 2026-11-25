import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Logger,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import { IntegrationSyncRun, Prisma } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';
import {
  ActorContext,
  CurrentActor,
  RequireScopes,
} from '../../common/auth/auth.decorators';
import { Problems, ProblemException } from '../../common/errors/problem-details.exception';
import {
  buildCursorPage,
  decodeCursor,
  PaginationQueryDto,
} from '../../common/pagination/cursor-pagination';
import { PrismaService } from '../../common/prisma/prisma.module';
import { UpstreamError } from '../../common/resilience/upstream-error';
import { AuditService } from '../audit/audit.module';
import { Idempotent } from '../idempotency/idempotency.module';
import { FIXTURE_FILES } from '../upstream/upstream-adapters';
import {
  FixturesPathError,
  resolveFixturesDirectory,
  UpstreamRegistry,
} from '../upstream/upstream.module';
import {
  CrmCustomerRecord,
  ErpEntitlementRecord,
  UpstreamAdapters,
  UsageFeedRecord,
} from '../upstream/upstream.types';
import { changedFields, crossValidateSources, isConsistent } from './fixture-reconciliation';

export class SyncFixturesDto {
  @IsOptional()
  @IsString()
  fixturesDir?: string;
}

interface FetchedSources {
  customers: CrmCustomerRecord[];
  entitlements: ErpEntitlementRecord[];
  usage: UsageFeedRecord[];
}

function upstreamErrorToProblem(errors: UpstreamError[]): ProblemException {
  const detail = errors.map((e) => e.message).join(' ');
  if (errors.some((e) => e.kind === 'NOT_FOUND')) {
    return Problems.unprocessable(detail, 'FIXTURE_FILE_MISSING');
  }
  if (errors.every((e) => e.kind === 'INVALID_RESPONSE')) {
    return Problems.unprocessable(detail, 'FIXTURE_INVALID');
  }
  const retryAfterMs = Math.max(0, ...errors.map((e) => e.retryAfterMs ?? 0));
  return Problems.serviceUnavailable(
    detail,
    'UPSTREAM_UNAVAILABLE',
    retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : undefined,
  );
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly upstreams: UpstreamRegistry,
  ) {}

  async syncFixtures(dto: SyncFixturesDto | undefined, actor: ActorContext) {
    const relativeDir = dto?.fixturesDir;
    let sourceSummary = relativeDir ?? 'default-upstreams';

    try {
      const adapters = this.selectAdapters(relativeDir);
      sourceSummary = relativeDir
        ? `${relativeDir}/{${FIXTURE_FILES.crm},${FIXTURE_FILES.erp},${FIXTURE_FILES.usage}}`
        : `crm=${adapters.crm.description};erp=${adapters.erp.description};usage=${adapters.usage.description}`;

      const fetched = await this.fetchAll(adapters);
      const validation = crossValidateSources(fetched.customers, fetched.entitlements, fetched.usage);
      if (!isConsistent(validation)) {
        throw Problems.unprocessable(
          `Cross-fixture accountId mismatch. Unknown XML accounts: [${validation.unknownErpAccounts.join(', ')}]; Unknown CSV accounts: [${validation.unknownUsageAccounts.join(', ')}]; Duplicate CRM accounts: [${validation.duplicateCustomerIds.join(', ')}].`,
          'FIXTURE_ACCOUNT_MISMATCH',
        );
      }
      return await this.persist(fetched, validation.consistentAccountIds, sourceSummary, actor);
    } catch (err) {
      await this.recordFailedRun(sourceSummary, err);
      throw err;
    }
  }

  async listSyncRuns(query: PaginationQueryDto) {
    const limit = query.limit ?? 20;
    const cursorId = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = await this.prisma.integrationSyncRun.findMany({
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const page = buildCursorPage(rows, limit);
    return {
      data: page.data.map((r) => this.toRunDto(r)),
      page: page.page,
    };
  }

  private selectAdapters(relativeDir: string | undefined): UpstreamAdapters {
    if (relativeDir === undefined) {
      return this.upstreams.default;
    }
    try {
      return this.upstreams.fromFixturesDirectory(resolveFixturesDirectory(relativeDir));
    } catch (err) {
      if (err instanceof FixturesPathError) {
        throw Problems.unprocessable(err.message, 'INVALID_FIXTURES_PATH');
      }
      throw err;
    }
  }

  private async fetchAll(adapters: UpstreamAdapters): Promise<FetchedSources> {
    const [customers, entitlements, usage] = await Promise.allSettled([
      adapters.crm.fetchCustomers(),
      adapters.erp.fetchEntitlements(),
      adapters.usage.fetchEvents(),
    ]);

    const failures = [customers, entitlements, usage]
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as unknown);
    if (failures.length > 0) {
      const nonUpstream = failures.find((f) => !(f instanceof UpstreamError));
      if (nonUpstream) {
        throw nonUpstream;
      }
      throw upstreamErrorToProblem(failures as UpstreamError[]);
    }

    return {
      customers: (customers as PromiseFulfilledResult<CrmCustomerRecord[]>).value,
      entitlements: (entitlements as PromiseFulfilledResult<ErpEntitlementRecord[]>).value,
      usage: (usage as PromiseFulfilledResult<UsageFeedRecord[]>).value,
    };
  }

  private async persist(
    fetched: FetchedSources,
    consistentAccountIds: string[],
    sourceSummary: string,
    actor: ActorContext,
  ) {
    const completedAt = new Date();

    const syncRun = await this.prisma.$transaction(async (tx) => {
      const customersChanged = await this.upsertCustomers(tx, fetched.customers);
      const entitlementsChanged = await this.upsertEntitlements(tx, fetched.entitlements);

      for (const usage of fetched.usage) {
        const data = {
          accountId: usage.accountId,
          metricCode: usage.metricCode,
          quantity: usage.quantity,
          source: usage.source,
          recordedAt: usage.recordedAt,
        };
        await tx.usageEvent.upsert({
          where: { externalEventId: usage.externalEventId },
          create: { externalEventId: usage.externalEventId, ...data },
          update: data,
        });
      }

      const run = await tx.integrationSyncRun.create({
        data: {
          sourceSummary,
          status: 'COMPLETED',
          customersProcessed: fetched.customers.length,
          entitlementsProcessed: fetched.entitlements.length,
          usageEventsProcessed: fetched.usage.length,
          completedAt,
        },
      });

      await this.auditService.record(
        {
          actor,
          action: 'integrations.fixtures.synced',
          entityType: 'IntegrationSyncRun',
          entityId: run.id,
          metadata: {
            consistentAccountIds,
            customersUpserted: fetched.customers.length,
            entitlementsUpserted: fetched.entitlements.length,
            usageEventsUpserted: fetched.usage.length,
            customersChanged,
            entitlementsChanged,
          },
        },
        tx,
      );

      return run;
    });

    this.logger.log({
      msg: 'integrations.sync.completed',
      syncRunId: syncRun.id,
      sourceSummary,
      customers: fetched.customers.length,
      entitlements: fetched.entitlements.length,
      usageEvents: fetched.usage.length,
    });

    return {
      syncRunId: syncRun.id,
      status: 'COMPLETED' as const,
      consistentAccountIds,
      customersUpserted: fetched.customers.length,
      entitlementsUpserted: fetched.entitlements.length,
      usageEventsUpserted: fetched.usage.length,
      completedAt: completedAt.toISOString(),
    };
  }

  /**
   * Updates bump `version` only when a field actually changed, so clients
   * holding a current ETag are not invalidated by a no-op resync.
   */
  private async upsertCustomers(tx: Prisma.TransactionClient, customers: CrmCustomerRecord[]): Promise<number> {
    let changed = 0;
    for (const cust of customers) {
      const data = {
        externalCrmId: cust.externalCrmId,
        name: cust.name,
        primaryEmail: cust.primaryEmail,
        tier: cust.tier,
        status: cust.status,
        region: cust.region,
        annualRecurringRevenue: cust.annualRecurringRevenue,
      };
      const existing = await tx.customer.findUnique({ where: { accountId: cust.accountId } });
      if (!existing) {
        await tx.customer.create({ data: { accountId: cust.accountId, ...data } });
        changed += 1;
      } else if (changedFields(existing, data).length > 0) {
        await tx.customer.update({
          where: { accountId: cust.accountId },
          data: { ...data, version: { increment: 1 } },
        });
        changed += 1;
      }
    }
    return changed;
  }

  private async upsertEntitlements(
    tx: Prisma.TransactionClient,
    entitlements: ErpEntitlementRecord[],
  ): Promise<number> {
    let changed = 0;
    for (const ent of entitlements) {
      const data = {
        accountId: ent.accountId,
        contractRef: ent.contractRef,
        featureCode: ent.featureCode,
        kind: ent.kind,
        status: ent.status,
        quotaLimit: ent.quotaLimit,
        quotaUnit: ent.quotaUnit,
        supportLevel: ent.supportLevel,
        maxCaseSeverity: ent.maxCaseSeverity,
        slaResponseMinutes: ent.slaResponseMinutes,
        effectiveFrom: ent.effectiveFrom,
        effectiveTo: ent.effectiveTo,
      };
      const existing = await tx.entitlement.findUnique({ where: { externalId: ent.externalId } });
      if (!existing) {
        await tx.entitlement.create({ data: { externalId: ent.externalId, ...data } });
        changed += 1;
      } else if (changedFields(existing, data).length > 0) {
        await tx.entitlement.update({
          where: { externalId: ent.externalId },
          data: { ...data, version: { increment: 1 } },
        });
        changed += 1;
      }
    }
    return changed;
  }

  private async recordFailedRun(sourceSummary: string, err: unknown): Promise<void> {
    const detail =
      err instanceof ProblemException
        ? err.problem.detail
        : err instanceof Error
          ? err.message
          : String(err);
    this.logger.warn({ msg: 'integrations.sync.failed', sourceSummary, error: detail });
    try {
      await this.prisma.integrationSyncRun.create({
        data: { sourceSummary, status: 'FAILED', errorDetail: detail, completedAt: new Date() },
      });
    } catch (recordErr) {
      this.logger.error({
        msg: 'integrations.sync.failed_run_not_recorded',
        error: recordErr instanceof Error ? recordErr.message : String(recordErr),
      });
    }
  }

  private toRunDto(row: IntegrationSyncRun) {
    return {
      id: row.id,
      sourceSummary: row.sourceSummary,
      status: row.status as 'COMPLETED' | 'FAILED',
      customersProcessed: row.customersProcessed,
      entitlementsProcessed: row.entitlementsProcessed,
      usageEventsProcessed: row.usageEventsProcessed,
      errorDetail: row.errorDetail,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }
}

@Controller('v1/integrations')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Post('fixtures/sync')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integrations:write')
  @Idempotent()
  syncFixtures(
    @Body() dto: SyncFixturesDto | undefined,
    @CurrentActor() actor: ActorContext,
  ) {
    return this.integrationsService.syncFixtures(dto, actor);
  }

  @Get('sync-runs')
  @RequireScopes('integrations:write')
  listSyncRuns(@Query() query: PaginationQueryDto) {
    return this.integrationsService.listSyncRuns(query);
  }
}

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}

import { Customer, Entitlement } from '@prisma/client';
import { AppConfig } from '../../common/config/app-config';
import { ActorContext } from '../../common/auth/auth.decorators';
import { PrismaService } from '../../common/prisma/prisma.module';
import { AuditService } from '../audit/audit.module';
import { WebhookService } from '../webhook/webhook.module';
import { CustomerService } from './customer.module';

describe('customer aggregation', () => {
  it('returns available sections, reports a timed-out section, and hides ARR without its scope', async () => {
    const customer = {
      accountId: 'acct_123456',
      name: 'Example Customer',
      primaryEmail: 'ops@example.test',
      tier: 'BUSINESS',
      status: 'ACTIVE',
      externalCrmId: null,
      region: 'us-east',
      annualRecurringRevenue: 500000,
      version: 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as Customer;
    const entitlement = {
      id: 'ent_123456',
      accountId: customer.accountId,
      contractRef: null,
      featureCode: 'API_REQUESTS',
      kind: 'METERED_QUOTA',
      status: 'ACTIVE',
      quotaLimit: 100,
      quotaUnit: 'requests',
      supportLevel: null,
      maxCaseSeverity: null,
      slaResponseMinutes: null,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
      version: 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as Entitlement;
    const prisma = {
      customer: { findUnique: jest.fn().mockResolvedValue(customer) },
      entitlement: {
        findMany: jest.fn().mockImplementation(({ select }) => (select ? [entitlement] : [entitlement])),
      },
      usageEvent: {
        groupBy: jest.fn().mockResolvedValue([
          { metricCode: 'API_REQUESTS', _sum: { quantity: 120 }, _count: { _all: 2 } },
        ]),
      },
      supportCase: {
        findMany: jest.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve([]), 20)),
        ),
      },
    } as unknown as PrismaService;
    const config = { overview: { sectionTimeoutMs: 2 } } as AppConfig;
    const service = new CustomerService(
      prisma,
      {} as AuditService,
      {} as WebhookService,
      config,
    );
    const actor: ActorContext = {
      actorId: 'client',
      scopes: ['customers:read', 'entitlements:read', 'usage:read', 'cases:read'],
      traceId: 'trace_1',
    };

    const result = await service.getByAccountId(customer.accountId, actor);

    expect(result.accountId).toBe(customer.accountId);
    expect(result).not.toHaveProperty('annualRecurringRevenue');
    expect(result.entitlements).toHaveLength(1);
    expect(result.usage?.metrics).toEqual([
      expect.objectContaining({
        metricCode: 'API_REQUESTS',
        totalQuantity: 120,
        quotaLimit: 100,
        overQuota: true,
      }),
    ]);
    expect(result.cases).toBeNull();
    expect(result.partialFailures).toEqual([
      { section: 'cases', code: 'SECTION_UNAVAILABLE' },
    ]);
  });
});

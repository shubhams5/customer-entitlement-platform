import { ProblemException } from '../../common/errors/problem-details.exception';
import { UpstreamError } from '../../common/resilience/upstream-error';
import { PrismaService } from '../../common/prisma/prisma.module';
import { AuditService } from '../audit/audit.module';
import { UpstreamRegistry } from '../upstream/upstream.module';
import type { UpstreamAdapters } from '../upstream/upstream.types';
import { IntegrationsService } from './integrations.module';

describe('IntegrationsService upstream failures', () => {
  it('returns a 503 and records a failed sync run when an upstream times out', async () => {
    const prisma = {
      integrationSyncRun: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const adapters: UpstreamAdapters = {
      crm: {
        name: 'crm',
        description: 'http:crm',
        fetchCustomers: jest.fn().mockRejectedValue(UpstreamError.timeout('crm', 25)),
        fetchCustomer: jest.fn().mockResolvedValue(null),
      },
      erp: {
        name: 'erp',
        description: 'http:erp',
        fetchEntitlements: jest.fn().mockResolvedValue([]),
      },
      usage: {
        name: 'usage',
        description: 'http:usage',
        fetchEvents: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new IntegrationsService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
      { default: adapters } as unknown as UpstreamRegistry,
    );

    let thrown: unknown;
    try {
      await service.syncFixtures(undefined, {
        actorId: 'integration-test',
        scopes: ['integrations:write'],
        traceId: 'test-trace',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProblemException);
    expect((thrown as ProblemException).problem).toMatchObject({
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(prisma.integrationSyncRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'FAILED',
        errorDetail: expect.stringContaining('crm did not respond'),
      }),
    });
  });
});

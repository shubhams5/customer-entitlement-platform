import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { resolve } from 'path';
import { AppModule } from '../src/app.module';
import { configureNestFastifyApp } from '../src/bootstrap';
import { CasesService } from '../src/modules/cases/cases.module';
import { verifyWebhookSignature } from '../src/modules/webhook/webhook.module';

describe('Customer Entitlement & Support Case Platform (E2E)', () => {
  const projectRoot = resolve(__dirname, '..');
  const testDbFile = resolve(projectRoot, 'prisma', 'test-e2e.db');
  let app: NestFastifyApplication;
  let adminToken: string;
  let auditorToken: string;
  let customerReaderToken: string;
  let limitedWriterToken: string;

  let webhookServer: Server;
  let webhookTargetUrl: string;
  const receivedWebhooks: Array<{
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
  }> = [];

  beforeAll(async () => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const candidate = `${testDbFile}${suffix}`;
      try {
        if (existsSync(candidate)) {
          rmSync(candidate, { force: true });
        }
      } catch {
        // Windows SQLite handle may release asynchronously on process exit
      }
    }

    process.env.DATABASE_URL = 'file:./test-e2e.db';
    process.env.OAUTH_JWT_SECRET = 'e2e-test-hs256-secret-key-0123456789abcdef';

    execSync('npx prisma migrate deploy', {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: 'file:./test-e2e.db' },
      stdio: 'pipe',
    });

    webhookServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedWebhooks.push({
          headers: req.headers,
          rawBody: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });

    await new Promise<void>((resolveListen) => {
      webhookServer.listen(0, '127.0.0.1', () => resolveListen());
    });
    const port = (webhookServer.address() as AddressInfo).port;
    webhookTargetUrl = `http://127.0.0.1:${port}/callbacks`;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureNestFastifyApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (webhookServer) {
      await new Promise<void>((resolveClose) =>
        webhookServer.close(() => resolveClose()),
      );
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const candidate = `${testDbFile}${suffix}`;
      try {
        if (existsSync(candidate)) {
          rmSync(candidate, { force: true });
        }
      } catch {
        // Windows SQLite handle may release asynchronously on process exit
      }
    }
  });

  it('GET /health returns 200 without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('enforces OAuth2 Bearer authentication and scopes with RFC 9457 Problem Details', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/v1/customers' });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers['content-type']).toContain('application/problem+json');
    expect(unauth.json()).toMatchObject({
      type: 'https://api.platform.local/problems/unauthorized',
      title: 'Unauthorized',
      status: 401,
      code: 'MISSING_BEARER_TOKEN',
    });

    // Issue readonly auditor token via form-urlencoded
    const auditorRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload:
        'grant_type=client_credentials&client_id=readonly-auditor-client&client_secret=dev-secret-readonly-auditor',
    });
    expect(auditorRes.statusCode).toBe(200);
    auditorToken = auditorRes.json().access_token;

    // Auditor lacks customers:write scope -> 403 Problem Details
    const forbidden = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${auditorToken}` },
      payload: {
        accountId: 'acct_unauthorized_try',
        name: 'Denied Co',
        primaryEmail: 'denied@example.com',
        tier: 'STARTER',
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.headers['content-type']).toContain('application/problem+json');
    expect(forbidden.json()).toMatchObject({
      status: 403,
      code: 'INSUFFICIENT_SCOPE',
    });

    // Issue admin token with all scopes
    const adminRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grant_type: 'client_credentials',
        client_id: 'platform-admin-client',
        client_secret: 'dev-secret-platform-admin',
      },
    });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.json().access_token;

    const limitedWriterRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grant_type: 'client_credentials',
        client_id: 'platform-admin-client',
        client_secret: 'dev-secret-platform-admin',
        scope: 'customers:write',
      },
    });
    expect(limitedWriterRes.statusCode).toBe(200);
    limitedWriterToken = limitedWriterRes.json().access_token;

    const customerReaderRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grant_type: 'client_credentials',
        client_id: 'platform-admin-client',
        client_secret: 'dev-secret-platform-admin',
        scope: 'customers:read',
      },
    });
    expect(customerReaderRes.statusCode).toBe(200);
    customerReaderToken = customerReaderRes.json().access_token;
  });

  it('synchronizes consistent JSON, XML, and CSV fixtures idempotently', async () => {
    const syncRes = await app.inject({
      method: 'POST',
      url: '/v1/integrations/fixtures/sync',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'idempotency-key': 'idem-fixture-sync-001',
      },
      payload: { fixturesDir: 'fixtures' },
    });

    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.headers['idempotency-replayed']).toBe('false');
    const body = syncRes.json();
    expect(body).toMatchObject({
      status: 'COMPLETED',
      consistentAccountIds: [
        'acct_01J9X8K2M4N6P8Q0R2S4',
        'acct_01J9X8K2M4N6P8Q0R2S5',
        'acct_01J9X8K2M4N6P8Q0R2S6',
        'acct_01J9X8K2M4N6P8Q0R2S7',
      ],
      customersUpserted: 4,
      entitlementsUpserted: 11,
      usageEventsUpserted: 8,
    });

    const runsRes = await app.inject({
      method: 'GET',
      url: '/v1/integrations/sync-runs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(runsRes.statusCode).toBe(200);
    expect(runsRes.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it('supports cursor pagination and rejects invalid cursors with RFC 9457 400', async () => {
    const page1 = await app.inject({
      method: 'GET',
      url: '/v1/customers?limit=2',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(page1.statusCode).toBe(200);
    const p1Body = page1.json();
    expect(p1Body.data).toHaveLength(2);
    expect(p1Body.page.hasMore).toBe(true);
    expect(p1Body.page.nextCursor).toEqual(expect.any(String));

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/customers?limit=2&cursor=${encodeURIComponent(p1Body.page.nextCursor)}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(page2.statusCode).toBe(200);
    const p2Body = page2.json();
    expect(p2Body.data).toHaveLength(2);
    expect(p2Body.page.hasMore).toBe(false);

    const allIds = [...p1Body.data, ...p2Body.data].map((c: any) => c.accountId);
    expect(new Set(allIds).size).toBe(4);

    const badCursor = await app.inject({
      method: 'GET',
      url: '/v1/customers?cursor=corrupted_cursor_token',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json().code).toBe('INVALID_CURSOR');

    const customerOverview = await app.inject({
      method: 'GET',
      url: '/v1/customers/acct_01J9X8K2M4N6P8Q0R2S4',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(customerOverview.statusCode).toBe(200);
    expect(customerOverview.json()).toMatchObject({
      accountId: 'acct_01J9X8K2M4N6P8Q0R2S4',
      annualRecurringRevenue: 1850000,
      entitlements: expect.any(Array),
      usage: { metrics: expect.any(Array) },
      cases: [],
      partialFailures: [],
    });

    const restrictedOverview = await app.inject({
      method: 'GET',
      url: '/v1/customers/acct_01J9X8K2M4N6P8Q0R2S4',
      headers: { authorization: `Bearer ${customerReaderToken}` },
    });
    expect(restrictedOverview.statusCode).toBe(200);
    expect(restrictedOverview.json()).not.toHaveProperty('annualRecurringRevenue');
    expect(restrictedOverview.json().cases).toBeNull();
    expect(restrictedOverview.json().partialFailures).toEqual([
      { section: 'entitlements', code: 'SECTION_FORBIDDEN' },
      { section: 'usage', code: 'SECTION_FORBIDDEN' },
      { section: 'cases', code: 'SECTION_FORBIDDEN' },
    ]);
  });

  it('enforces Idempotency-Key replay and 409 conflict on payload mismatch', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'idempotency-key': 'idem-create-cust-9001',
      },
      payload: {
        accountId: 'acct_01J9Z0NEWCUSTOMER01',
        name: 'Orbit Quantum Systems',
        primaryEmail: 'cloud@orbitquantum.example',
        tier: 'ENTERPRISE',
        region: 'us-east',
      },
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-replayed']).toBe('false');
    expect(first.headers.etag).toBe('"v1"');

    // Exact replay with reordered keys
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'idempotency-key': 'idem-create-cust-9001',
      },
      payload: {
        tier: 'ENTERPRISE',
        region: 'us-east',
        primaryEmail: 'cloud@orbitquantum.example',
        name: 'Orbit Quantum Systems',
        accountId: 'acct_01J9Z0NEWCUSTOMER01',
      },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.headers.etag).toBe('"v1"');
    expect(replay.json()).toEqual(first.json());

    // Mutated payload with same Idempotency-Key -> 409 Conflict
    const mismatch = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'idempotency-key': 'idem-create-cust-9001',
      },
      payload: {
        accountId: 'acct_01J9Z0NEWCUSTOMER01',
        name: 'Different Name Mutation',
        primaryEmail: 'cloud@orbitquantum.example',
        tier: 'STARTER',
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
  });

  it('enforces ETag / If-Match optimistic concurrency (428 missing, 200 match, 412 stale)', async () => {
    const missingIfMatch = await app.inject({
      method: 'PATCH',
      url: '/v1/customers/acct_01J9Z0NEWCUSTOMER01',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { region: 'eu-west' },
    });
    expect(missingIfMatch.statusCode).toBe(428);
    expect(missingIfMatch.json().code).toBe('IF_MATCH_REQUIRED');

    const okUpdate = await app.inject({
      method: 'PATCH',
      url: '/v1/customers/acct_01J9Z0NEWCUSTOMER01',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'if-match': '"v1"',
      },
      payload: { region: 'eu-west' },
    });
    expect(okUpdate.statusCode).toBe(200);
    expect(okUpdate.headers.etag).toBe('"v2"');
    expect(okUpdate.json().version).toBe(2);

    const staleUpdate = await app.inject({
      method: 'PATCH',
      url: '/v1/customers/acct_01J9Z0NEWCUSTOMER01',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'if-match': '"v1"',
      },
      payload: { region: 'ap-northeast' },
    });
    expect(staleUpdate.statusCode).toBe(412);
    expect(staleUpdate.json().code).toBe('ETAG_MISMATCH');

    const forbiddenArrWrite = await app.inject({
      method: 'PATCH',
      url: '/v1/customers/acct_01J9Z0NEWCUSTOMER01',
      headers: {
        authorization: `Bearer ${limitedWriterToken}`,
        'if-match': '"v2"',
      },
      payload: { annualRecurringRevenue: 5000 },
    });
    expect(forbiddenArrWrite.statusCode).toBe(403);
    expect(forbiddenArrWrite.json().code).toBe('FIELD_WRITE_FORBIDDEN');

    const allowedArrWrite = await app.inject({
      method: 'PATCH',
      url: '/v1/customers/acct_01J9Z0NEWCUSTOMER01',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'if-match': '"v2"',
      },
      payload: { annualRecurringRevenue: 5000 },
    });
    expect(allowedArrWrite.statusCode).toBe(200);
    expect(allowedArrWrite.json().annualRecurringRevenue).toBe(5000);

    const concurrentUpdates = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: '/v1/customers/acct_01J9Z0NEWCUSTOMER01',
        headers: { authorization: `Bearer ${adminToken}`, 'if-match': '"v3"' },
        payload: { region: 'us-west' },
      }),
      app.inject({
        method: 'PATCH',
        url: '/v1/customers/acct_01J9Z0NEWCUSTOMER01',
        headers: { authorization: `Bearer ${adminToken}`, 'if-match': '"v3"' },
        payload: { region: 'ap-south' },
      }),
    ]);
    expect(concurrentUpdates.map((result) => result.statusCode).sort()).toEqual([200, 412]);
    const afterConcurrentUpdate = await app.inject({
      method: 'GET',
      url: '/v1/customers/acct_01J9Z0NEWCUSTOMER01',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(afterConcurrentUpdate.json().version).toBe(4);
  });

  it('evaluates entitlements, enforces case SLA/severity rules, emits & verifies signed webhooks, and records audit trail', async () => {
    // 1. Register webhook subscription for case & usage events
    const whCreate = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'idempotency-key': 'idem-webhook-sub-001',
      },
      payload: {
        url: webhookTargetUrl,
        description: 'E2E callback listener',
        subscribedEvents: [
          'case.created',
          'case.escalated',
          'usage.threshold.exceeded',
        ],
        signingSecret: 'whsec_e2e_signing_secret_9876543210',
      },
    });
    expect(whCreate.statusCode).toBe(201);
    const signingSecret: string = whCreate.json().signingSecret;

    // 2. Entitlement evaluation: Acme has ENTERPRISE_SSO, Velox is SUSPENDED
    const acmeEval = await app.inject({
      method: 'POST',
      url: '/v1/entitlements/evaluate',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        accountId: 'acct_01J9X8K2M4N6P8Q0R2S4',
        featureCode: 'ENTERPRISE_SSO',
      },
    });
    expect(acmeEval.statusCode).toBe(200);
    expect(acmeEval.json()).toMatchObject({
      allowed: true,
      reasonCode: 'ENTITLED',
    });

    const veloxEval = await app.inject({
      method: 'POST',
      url: '/v1/entitlements/evaluate',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        accountId: 'acct_01J9X8K2M4N6P8Q0R2S6',
        featureCode: 'SUPPORT_PORTAL',
      },
    });
    expect(veloxEval.statusCode).toBe(200);
    expect(veloxEval.json()).toMatchObject({
      allowed: false,
      reasonCode: 'ACCOUNT_SUSPENDED',
    });

    // 3. Support Case denial: Velox (SUSPENDED) -> 422 ACCOUNT_SUSPENDED
    const suspendedCase = await app.inject({
      method: 'POST',
      url: '/v1/cases',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        accountId: 'acct_01J9X8K2M4N6P8Q0R2S6',
        subject: 'Cannot access workspace',
        description: 'Attempting to file a ticket while account is suspended.',
        severity: 'P3',
        requesterEmail: 'it-admin@veloxbiolabs.example',
      },
    });
    expect(suspendedCase.statusCode).toBe(422);
    expect(suspendedCase.json().code).toBe('ACCOUNT_SUSPENDED');

    // 4. Support Case denial: Northstar has maxCaseSeverity P2 -> P1 rejected
    const p1Denied = await app.inject({
      method: 'POST',
      url: '/v1/cases',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        accountId: 'acct_01J9X8K2M4N6P8Q0R2S5',
        subject: 'Production payment latency spike',
        description: 'Requesting P1 critical response on Priority (max P2) plan.',
        severity: 'P1',
        requesterEmail: 'platform-eng@northstarfintech.example',
      },
    });
    expect(p1Denied.statusCode).toBe(422);
    expect(p1Denied.json().code).toBe('SEVERITY_NOT_ENTITLED');

    // 5. Support Case success: Acme opens P1 case -> 15 min SLA + case.created webhook
    const acmeCaseRes = await app.inject({
      method: 'POST',
      url: '/v1/cases',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'idempotency-key': 'idem-acme-p1-case-001',
      },
      payload: {
        accountId: 'acct_01J9X8K2M4N6P8Q0R2S4',
        subject: 'Global customs EDI gateway timeout',
        description: 'Primary EDI cluster in us-east experiencing elevated 504 timeouts.',
        severity: 'P1',
        requesterEmail: 'ops@acmelogistics.example',
      },
    });
    expect(acmeCaseRes.statusCode).toBe(201);
    expect(acmeCaseRes.headers.etag).toBe('"v1"');
    const createdCase = acmeCaseRes.json();
    expect(createdCase.entitledSupportLevel).toBe('MISSION_CRITICAL');

    const slaDeltaMinutes = Math.round(
      (new Date(createdCase.slaResponseDueAt).getTime() -
        new Date(createdCase.createdAt).getTime()) /
        60000,
    );
    expect(slaDeltaMinutes).toBe(15);

    // 6. Add comment & escalate case with If-Match
    const commentPayload = {
      authorId: 'agent_priya',
      authorRole: 'AGENT',
      body: 'Engaging L3 network engineering team immediately.',
      isInternal: false,
    } as const;
    const unauthorizedComment = await app.inject({
      method: 'POST',
      url: `/v1/cases/${createdCase.id}/comments`,
      headers: {
        authorization: `Bearer ${limitedWriterToken}`,
        'idempotency-key': 'idem-case-comment-forbidden-001',
      },
      payload: commentPayload,
    });
    expect(unauthorizedComment.statusCode).toBe(403);
    expect(unauthorizedComment.json().code).toBe('INSUFFICIENT_SCOPE');
    const unauthorizedEscalation = await app.inject({
      method: 'PATCH',
      url: `/v1/cases/${createdCase.id}`,
      headers: {
        authorization: `Bearer ${limitedWriterToken}`,
        'if-match': '"v1"',
      },
      payload: { status: 'ESCALATED' },
    });
    expect(unauthorizedEscalation.statusCode).toBe(403);
    expect(unauthorizedEscalation.json().code).toBe('INSUFFICIENT_SCOPE');

    const commentRes = await app.inject({
      method: 'POST',
      url: `/v1/cases/${createdCase.id}/comments`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'idempotency-key': 'idem-case-comment-001',
      },
      payload: commentPayload,
    });
    expect(commentRes.statusCode).toBe(201);
    const replayedComment = await app.inject({
      method: 'POST',
      url: `/v1/cases/${createdCase.id}/comments`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'idempotency-key': 'idem-case-comment-001',
      },
      payload: commentPayload,
    });
    expect(replayedComment.statusCode).toBe(201);
    expect(replayedComment.headers['idempotency-replayed']).toBe('true');
    expect(replayedComment.json().id).toBe(commentRes.json().id);
    const persistedReplay = await app.get(CasesService).addComment(
      createdCase.id,
      commentPayload,
      {
        actorId: 'platform-admin-client',
        scopes: [],
        traceId: 'e2e',
      },
      'idem-case-comment-001',
    );
    expect(persistedReplay.id).toBe(commentRes.json().id);

    const concurrentCommentBody = 'Concurrent idempotency request must create one comment.';
    const concurrentComments = await Promise.all(
      Array.from({ length: 2 }, () => app.inject({
        method: 'POST',
        url: `/v1/cases/${createdCase.id}/comments`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          'idempotency-key': 'idem-case-comment-concurrent-001',
        },
        payload: { ...commentPayload, body: concurrentCommentBody },
      })),
    );
    expect(concurrentComments.some((result) => result.statusCode === 201)).toBe(true);
    expect(concurrentComments.every((result) => [201, 409].includes(result.statusCode))).toBe(true);
    const caseAfterConcurrentComment = await app.inject({
      method: 'GET',
      url: `/v1/cases/${createdCase.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(
      caseAfterConcurrentComment.json().comments.filter((comment: any) => comment.body === concurrentCommentBody),
    ).toHaveLength(1);

    const escalateRes = await app.inject({
      method: 'PATCH',
      url: `/v1/cases/${createdCase.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'if-match': '"v1"',
      },
      payload: {
        status: 'ESCALATED',
        assigneeId: 'sre_oncall_lead',
      },
    });
    expect(escalateRes.statusCode).toBe(200);
    expect(escalateRes.headers.etag).toBe('"v2"');
    expect(escalateRes.json().status).toBe('ESCALATED');
    expect(escalateRes.json().escalatedAt).toEqual(expect.any(String));

    const secondCase = await app.inject({
      method: 'POST',
      url: '/v1/cases',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        accountId: 'acct_01J9X8K2M4N6P8Q0R2S4',
        subject: 'Regional EDI certificate warning',
        description: 'Certificate renewal is due soon for the regional gateway.',
        severity: 'P4',
        requesterEmail: 'ops@acmelogistics.example',
      },
    });
    expect(secondCase.statusCode).toBe(201);

    const casePage1 = await app.inject({
      method: 'GET',
      url: '/v1/cases?accountId=acct_01J9X8K2M4N6P8Q0R2S4&sort=-createdAt&limit=1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(casePage1.statusCode).toBe(200);
    expect(casePage1.json().page.hasMore).toBe(true);
    const casePage2 = await app.inject({
      method: 'GET',
      url: `/v1/cases?accountId=acct_01J9X8K2M4N6P8Q0R2S4&sort=-createdAt&limit=1&cursor=${encodeURIComponent(casePage1.json().page.nextCursor)}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(casePage2.statusCode).toBe(200);
    expect(casePage2.json().page.hasMore).toBe(false);
    expect(casePage1.json().data[0].id).not.toBe(casePage2.json().data[0].id);

    const filteredCases = await app.inject({
      method: 'GET',
      url: '/v1/cases?accountId=acct_01J9X8K2M4N6P8Q0R2S4&status=ESCALATED&severity=P1&assigneeId=sre_oncall_lead&q=Global%20customs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(filteredCases.statusCode).toBe(200);
    expect(filteredCases.json().data.map((c: any) => c.id)).toEqual([createdCase.id]);

    // 7. Record usage crossing quota threshold for Northstar (93,000 + 10,000 = 103,000 / 100,000)
    const usageRes = await app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'idempotency-key': 'idem-usage-burst-001',
      },
      payload: {
        externalEventId: 'usg_live_burst_9001',
        accountId: 'acct_01J9X8K2M4N6P8Q0R2S5',
        metricCode: 'API_REQUESTS_MONTHLY',
        quantity: 10000,
        source: 'api-gateway',
      },
    });
    expect(usageRes.statusCode).toBe(201);
    expect(usageRes.json().quotaStatus).toMatchObject({
      metricCode: 'API_REQUESTS_MONTHLY',
      currentUsage: 103000,
      quotaLimit: 100000,
      overQuota: true,
    });

    const summaryRes = await app.inject({
      method: 'GET',
      url: '/v1/usage/summary?accountId=acct_01J9X8K2M4N6P8Q0R2S5',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(summaryRes.statusCode).toBe(200);
    const apiMetric = summaryRes
      .json()
      .metrics.find((m: any) => m.metricCode === 'API_REQUESTS_MONTHLY');
    expect(apiMetric).toMatchObject({
      totalQuantity: 103000,
      quotaLimit: 100000,
      remainingQuota: 0,
      overQuota: true,
    });

    // 8. Inspect & dispatch outbound webhook deliveries, verifying HMAC-SHA256 signature
    const deliveriesRes = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/deliveries',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deliveriesRes.statusCode).toBe(200);
    const deliveries = deliveriesRes.json().data;
    expect(deliveries.map((d: any) => d.eventType)).toEqual(
      expect.arrayContaining([
        'case.created',
        'case.escalated',
        'usage.threshold.exceeded',
      ]),
    );

    const targetDelivery = deliveries[0];
    const dispatchResponses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/webhooks/deliveries/${targetDelivery.id}/dispatch`,
        headers: { authorization: `Bearer ${adminToken}` },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/webhooks/deliveries/${targetDelivery.id}/dispatch`,
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    ]);
    expect(dispatchResponses.every((response) => [200, 409].includes(response.statusCode))).toBe(true);
    expect(dispatchResponses.some((response) => response.statusCode === 200)).toBe(true);
    const dispatchRes = dispatchResponses.find((response) => response.statusCode === 200)!;
    expect(dispatchRes.json()).toMatchObject({
      id: targetDelivery.id,
      status: 'DELIVERED',
      responseStatus: 200,
      attemptCount: 1,
    });

    expect(receivedWebhooks).toHaveLength(1);
    const captured = receivedWebhooks[0];
    const sigHeader = String(captured.headers['x-webhook-signature'] ?? '');
    expect(verifyWebhookSignature(signingSecret, sigHeader, captured.rawBody)).toBe(
      true,
    );
    expect(verifyWebhookSignature(signingSecret, sigHeader, `${captured.rawBody} `)).toBe(false);
    expect(verifyWebhookSignature('wrong-signing-secret-123456', sigHeader, captured.rawBody)).toBe(false);

    const replayDispatch = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/deliveries/${targetDelivery.id}/dispatch`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(replayDispatch.statusCode).toBe(200);
    expect(replayDispatch.json()).toMatchObject({ status: 'DELIVERED', attemptCount: 1 });
    expect(receivedWebhooks).toHaveLength(1);

    // 9. Verify immutable audit trail via readonly auditor token
    const auditRes = await app.inject({
      method: 'GET',
      url: '/v1/audit/events?limit=50',
      headers: { authorization: `Bearer ${auditorToken}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const actions = auditRes.json().data.map((a: any) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'integrations.fixtures.synced',
        'customer.created',
        'customer.updated',
        'case.created',
        'case.comment.added',
        'case.escalated',
        'usage.recorded',
        'webhook.delivery.dispatched',
        'webhook.delivery.replay_blocked',
      ]),
    );
  });

  it('returns structured field-level RFC 9457 errors on DTO validation failure', async () => {
    const invalidRes = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        accountId: 'invalid-prefix',
        name: 'A',
        primaryEmail: 'not-an-email',
        tier: 'ENTERPRISE',
      },
    });
    expect(invalidRes.statusCode).toBe(400);
    expect(invalidRes.headers['content-type']).toContain('application/problem+json');
    const problem = invalidRes.json();
    expect(problem).toMatchObject({
      type: 'https://api.platform.local/problems/bad-request',
      title: 'Bad Request',
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'accountId' }),
        expect.objectContaining({ field: 'name' }),
        expect.objectContaining({ field: 'primaryEmail' }),
      ]),
    );
  });
});

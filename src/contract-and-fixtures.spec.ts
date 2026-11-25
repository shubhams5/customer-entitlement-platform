import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { signHs256Jwt, verifyHs256Jwt } from './common/auth/jwt.util';
import {
  assertExpectedVersion,
  formatEtag,
  parseIfMatchVersion,
} from './common/concurrency/etag.util';
import { ProblemException } from './common/errors/problem-details.exception';
import { decodeCursor, encodeCursor } from './common/pagination/cursor-pagination';
import { hashRequestBody } from './modules/idempotency/idempotency.module';
import {
  computeWebhookSignature,
  verifyWebhookSignature,
} from './modules/webhook/webhook.module';

describe('OpenAPI Contract, Fixture Consistency, and Core Primitives', () => {
  const rootDir = resolve(__dirname, '..');

  it('validates openapi.yaml 3.1.0 contract completeness', () => {
    const raw = readFileSync(resolve(rootDir, 'openapi.yaml'), 'utf8');
    const doc = parseYaml(raw) as Record<string, any>;

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components?.securitySchemes?.oauth2?.flows?.clientCredentials).toBeDefined();
    expect(doc.components?.schemas?.ProblemDetails?.required).toEqual(
      expect.arrayContaining(['type', 'title', 'status', 'detail']),
    );

    const expectedPaths = [
      '/health',
      '/oauth/token',
      '/v1/customers',
      '/v1/customers/{accountId}',
      '/v1/entitlements',
      '/v1/entitlements/evaluate',
      '/v1/entitlements/{entitlementId}',
      '/v1/usage/events',
      '/v1/usage/summary',
      '/v1/cases',
      '/v1/cases/{caseId}',
      '/v1/cases/{caseId}/comments',
      '/v1/cases/{caseId}/escalate',
      '/v1/integrations/fixtures/sync',
      '/v1/integrations/sync-runs',
      '/v1/audit/events',
      '/v1/webhooks/endpoints',
      '/v1/webhooks/deliveries',
      '/v1/webhooks/deliveries/{deliveryId}/dispatch',
    ];
    for (const p of expectedPaths) {
      expect(doc.paths[p]).toBeDefined();
    }

    expect(doc.webhooks?.platformEvent?.post).toBeDefined();
    expect(doc.paths['/v1/customers/{accountId}'].get.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CustomerOverview',
    });
    expect(doc.paths['/v1/cases'].get.parameters.map((p: { name?: string }) => p.name)).toEqual(
      expect.arrayContaining(['assigneeId', 'q', 'createdAfter', 'createdBefore', 'sort']),
    );
    expect(doc.components.schemas.CustomerTier.enum).toContain('Platinum');
    expect(doc.components.schemas.CreateCustomerRequest.properties.accountId.pattern).toContain('ACC-');
    expect(doc.components.schemas.WebhookEventType.enum).toContain('case.escalated');
  });

  it('ensures JSON, XML, and CSV fixtures share identical canonical account IDs', () => {
    const crm = JSON.parse(
      readFileSync(resolve(rootDir, 'fixtures/crm-customers.json'), 'utf8'),
    ) as { customers: Array<{ accountId: string }> };
    const jsonIds = crm.customers.map((c) => c.accountId).sort();
    expect(jsonIds).toEqual([
      'acct_01J9X8K2M4N6P8Q0R2S4',
      'acct_01J9X8K2M4N6P8Q0R2S5',
      'acct_01J9X8K2M4N6P8Q0R2S6',
      'acct_01J9X8K2M4N6P8Q0R2S7',
    ]);

    const xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    const xml = xmlParser.parse(
      readFileSync(resolve(rootDir, 'fixtures/erp-entitlements.xml'), 'utf8'),
    ) as {
      EntitlementCatalog: { AccountContract: Array<{ '@_accountId': string }> };
    };
    const xmlIds = xml.EntitlementCatalog.AccountContract.map(
      (c) => c['@_accountId'],
    ).sort();
    expect(xmlIds).toEqual(jsonIds);

    const csvRows = parseCsv(
      readFileSync(resolve(rootDir, 'fixtures/usage-events.csv'), 'utf8'),
      { columns: true, skip_empty_lines: true, trim: true },
    ) as Array<{ account_id: string }>;
    const csvIds = Array.from(new Set(csvRows.map((r) => r.account_id))).sort();
    expect(csvIds).toEqual(jsonIds);
  });

  it('keeps the assignment demo account and renewal consistent across its fixtures', () => {
    const assignmentDir = resolve(rootDir, 'fixtures/assignment-demo');
    const crm = JSON.parse(
      readFileSync(resolve(assignmentDir, 'crm-customers.json'), 'utf8'),
    ) as { customers: Array<{ accountId: string; tier: string }> };
    const assignmentCase = JSON.parse(
      readFileSync(resolve(assignmentDir, 'case.json'), 'utf8'),
    ) as { accountId: string; severity: string; status: string; openedAt: string };
    const xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    const xml = xmlParser.parse(
      readFileSync(resolve(assignmentDir, 'erp-entitlements.xml'), 'utf8'),
    ) as {
      EntitlementCatalog: {
      AccountContract: {
        '@_accountId': string;
        Entitlement: { EffectiveTo: string };
      } | Array<{
        '@_accountId': string;
        Entitlement: { EffectiveTo: string };
      }>;
      };
    };
    const [customer] = crm.customers;
    const contracts = Array.isArray(xml.EntitlementCatalog.AccountContract)
      ? xml.EntitlementCatalog.AccountContract
      : [xml.EntitlementCatalog.AccountContract];
    const [contract] = contracts;
    expect(customer).toMatchObject({ accountId: 'ACC-007', tier: 'Platinum' });
    expect(assignmentCase).toMatchObject({
      accountId: customer.accountId,
      severity: 'P1',
      status: 'OPEN',
      openedAt: '2026-10-24T08:12:00.000Z',
    });
    expect(contract['@_accountId']).toBe(customer.accountId);
    expect(contract.Entitlement.EffectiveTo).toBe('2027-01-15T00:00:00.000Z');
  });

  it('signs and verifies HS256 OAuth JWTs and rejects tampered or expired tokens', () => {
    const { token } = signHs256Jwt({
      sub: 'test-client',
      scopes: ['customers:read', 'cases:write'],
      expiresInSeconds: 300,
    });
    const claims = verifyHs256Jwt(token);
    expect(claims.sub).toBe('test-client');
    expect(claims.scope).toBe('customers:read cases:write');

    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(() => verifyHs256Jwt(tampered)).toThrow(ProblemException);

    const expired = signHs256Jwt({
      sub: 'test-client',
      scopes: ['customers:read'],
      expiresInSeconds: -10,
    });
    expect(() => verifyHs256Jwt(expired.token)).toThrow(ProblemException);
  });

  it('computes canonical payload hashes, cursors, ETags, and HMAC webhook signatures', () => {
    const h1 = hashRequestBody({ b: 2, a: { y: true, x: [1, 2] } });
    const h2 = hashRequestBody({ a: { x: [1, 2], y: true }, b: 2 });
    expect(h1).toBe(h2);

    const cursor = encodeCursor('c_12345');
    expect(decodeCursor(cursor)).toBe('c_12345');
    expect(() => decodeCursor('not-valid-json')).toThrow(ProblemException);

    expect(formatEtag(3)).toBe('"v3"');
    expect(parseIfMatchVersion('"v3"')).toBe(3);
    expect(parseIfMatchVersion('W/"v7"')).toBe(7);
    expect(() => parseIfMatchVersion(undefined)).toThrow(ProblemException);
    expect(() => assertExpectedVersion(1, 2)).toThrow(ProblemException);

    const body = JSON.stringify({ id: 'evt_1', type: 'case.created' });
    const sig = computeWebhookSignature('whsec_test_secret_123456', 1764045600, body);
    expect(verifyWebhookSignature('whsec_test_secret_123456', sig, body)).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong_secret_12345', sig, body)).toBe(false);
  });
});

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { ResiliencePolicy } from '../../common/config/app-config';
import { ResilientHttpClient } from '../../common/resilience/http-client';
import { UpstreamError } from '../../common/resilience/upstream-error';
import {
  parseCrmCustomer,
  parseCrmCustomersJson,
  parseErpEntitlementsXml,
  parseUsageCsv,
} from './upstream-parsers';
import {
  CrmAdapter,
  CrmCustomerRecord,
  ErpAdapter,
  ErpEntitlementRecord,
  UsageFeedAdapter,
  UsageFeedRecord,
} from './upstream.types';

export const FIXTURE_FILES = {
  crm: 'crm-customers.json',
  erp: 'erp-entitlements.xml',
  usage: 'usage-events.csv',
} as const;

async function readFixture(upstream: string, absPath: string): Promise<string> {
  try {
    return await readFile(absPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw UpstreamError.notFound(upstream, `Required fixture file missing at '${absPath}'.`);
    }
    throw UpstreamError.network(upstream, err);
  }
}

export class FileCrmAdapter implements CrmAdapter {
  readonly name = 'crm';
  readonly description: string;
  private readonly path: string;

  constructor(dir: string) {
    this.path = resolve(dir, FIXTURE_FILES.crm);
    this.description = `file:${FIXTURE_FILES.crm}`;
  }

  async fetchCustomers(): Promise<CrmCustomerRecord[]> {
    return parseCrmCustomersJson(this.name, await readFixture(this.name, this.path));
  }

  async fetchCustomer(accountId: string): Promise<CrmCustomerRecord | null> {
    return (await this.fetchCustomers()).find((c) => c.accountId === accountId) ?? null;
  }
}

export class FileErpAdapter implements ErpAdapter {
  readonly name = 'erp';
  readonly description: string;
  private readonly path: string;

  constructor(dir: string) {
    this.path = resolve(dir, FIXTURE_FILES.erp);
    this.description = `file:${FIXTURE_FILES.erp}`;
  }

  async fetchEntitlements(): Promise<ErpEntitlementRecord[]> {
    return parseErpEntitlementsXml(this.name, await readFixture(this.name, this.path));
  }
}

export class FileUsageFeedAdapter implements UsageFeedAdapter {
  readonly name = 'usage';
  readonly description: string;
  private readonly path: string;

  constructor(dir: string) {
    this.path = resolve(dir, FIXTURE_FILES.usage);
    this.description = `file:${FIXTURE_FILES.usage}`;
  }

  async fetchEvents(): Promise<UsageFeedRecord[]> {
    return parseUsageCsv(this.name, await readFixture(this.name, this.path));
  }
}

export class HttpCrmAdapter implements CrmAdapter {
  readonly name = 'crm';
  readonly description: string;

  constructor(
    private readonly baseUrl: string,
    private readonly http: ResilientHttpClient,
    private readonly policy: ResiliencePolicy,
  ) {
    this.description = `http:${baseUrl}`;
  }

  async fetchCustomers(): Promise<CrmCustomerRecord[]> {
    const body = await this.http.getText(this.name, `${this.baseUrl}/customers`, this.policy);
    return parseCrmCustomersJson(this.name, body);
  }

  async fetchCustomer(accountId: string): Promise<CrmCustomerRecord | null> {
    let body: string;
    try {
      body = await this.http.getText(
        this.name,
        `${this.baseUrl}/customers/${encodeURIComponent(accountId)}`,
        this.policy,
      );
    } catch (err) {
      if (err instanceof UpstreamError && err.kind === 'NOT_FOUND') {
        return null;
      }
      throw err;
    }
    try {
      return parseCrmCustomer(this.name, JSON.parse(body));
    } catch (err) {
      if (err instanceof UpstreamError) {
        throw err;
      }
      throw UpstreamError.invalidResponse(this.name, 'body is not valid JSON');
    }
  }
}

export class HttpErpAdapter implements ErpAdapter {
  readonly name = 'erp';
  readonly description: string;

  constructor(
    private readonly baseUrl: string,
    private readonly http: ResilientHttpClient,
    private readonly policy: ResiliencePolicy,
  ) {
    this.description = `http:${baseUrl}`;
  }

  async fetchEntitlements(): Promise<ErpEntitlementRecord[]> {
    const body = await this.http.getText(
      this.name,
      `${this.baseUrl}/entitlements`,
      this.policy,
      'application/xml',
    );
    return parseErpEntitlementsXml(this.name, body);
  }
}

export class HttpUsageFeedAdapter implements UsageFeedAdapter {
  readonly name = 'usage';
  readonly description: string;

  constructor(
    private readonly baseUrl: string,
    private readonly http: ResilientHttpClient,
    private readonly policy: ResiliencePolicy,
  ) {
    this.description = `http:${baseUrl}`;
  }

  async fetchEvents(): Promise<UsageFeedRecord[]> {
    const body = await this.http.getText(this.name, `${this.baseUrl}/usage-events`, this.policy, 'text/csv');
    return parseUsageCsv(this.name, body);
  }
}

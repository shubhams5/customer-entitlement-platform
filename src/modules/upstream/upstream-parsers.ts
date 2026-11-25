import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import { UpstreamError } from '../../common/resilience/upstream-error';
import { CrmCustomerRecord, ErpEntitlementRecord, UsageFeedRecord } from './upstream.types';

function toArray<T>(val: T | T[] | undefined | null): T[] {
  if (val === undefined || val === null) {
    return [];
  }
  return Array.isArray(val) ? val : [val];
}

function requireString(upstream: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw UpstreamError.invalidResponse(upstream, `missing or empty field '${field}'`);
  }
  return value.trim();
}

function parseDate(upstream: string, value: unknown, field: string): Date {
  const date = new Date(String(value));
  if (value === undefined || value === null || Number.isNaN(date.getTime())) {
    throw UpstreamError.invalidResponse(upstream, `field '${field}' is not a valid timestamp`);
  }
  return date;
}

function optionalInt(upstream: string, value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw UpstreamError.invalidResponse(upstream, `field '${field}' must be a non-negative integer`);
  }
  return n;
}

export function parseCrmCustomer(upstream: string, raw: unknown): CrmCustomerRecord {
  if (raw === null || typeof raw !== 'object') {
    throw UpstreamError.invalidResponse(upstream, 'customer record is not an object');
  }
  const c = raw as Record<string, unknown>;
  return {
    accountId: requireString(upstream, c.accountId, 'accountId'),
    externalCrmId: typeof c.externalCrmId === 'string' && c.externalCrmId ? c.externalCrmId : null,
    name: requireString(upstream, c.name, 'name'),
    primaryEmail: requireString(upstream, c.primaryEmail, 'primaryEmail'),
    tier: requireString(upstream, c.tier, 'tier'),
    status: requireString(upstream, c.status, 'status'),
    region: typeof c.region === 'string' && c.region ? c.region : 'us-east',
    annualRecurringRevenue: optionalInt(upstream, c.annualRecurringRevenue, 'annualRecurringRevenue'),
  };
}

export function parseCrmCustomersJson(upstream: string, text: string): CrmCustomerRecord[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw UpstreamError.invalidResponse(upstream, 'body is not valid JSON');
  }
  const customers = (doc as { customers?: unknown })?.customers;
  if (!Array.isArray(customers)) {
    throw UpstreamError.invalidResponse(upstream, "expected a top-level 'customers' array");
  }
  return customers.map((c) => parseCrmCustomer(upstream, c));
}

export function parseErpEntitlementsXml(upstream: string, text: string): ErpEntitlementRecord[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let doc: { EntitlementCatalog?: { AccountContract?: unknown } };
  try {
    doc = parser.parse(text, true) as typeof doc;
  } catch (err) {
    throw UpstreamError.invalidResponse(upstream, `XML parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!doc?.EntitlementCatalog) {
    throw UpstreamError.invalidResponse(upstream, 'missing <EntitlementCatalog> root element');
  }

  const out: ErpEntitlementRecord[] = [];
  for (const contract of toArray(doc.EntitlementCatalog.AccountContract as Record<string, unknown>[])) {
    const accountId = requireString(upstream, contract['@_accountId'], 'AccountContract@accountId');
    const contractRef = requireString(upstream, contract['@_contractRef'], 'AccountContract@contractRef');

    for (const ent of toArray(contract.Entitlement as Record<string, unknown>[])) {
      const rawQuota = ent.QuotaLimit as { '#text'?: unknown; '@_unit'?: unknown } | number | string | undefined;
      let quotaLimit: number | null = null;
      let quotaUnit: string | null = null;
      if (typeof rawQuota === 'object' && rawQuota !== null) {
        quotaLimit = optionalInt(upstream, rawQuota['#text'], 'QuotaLimit');
        quotaUnit = rawQuota['@_unit'] ? String(rawQuota['@_unit']) : null;
      } else {
        quotaLimit = optionalInt(upstream, rawQuota, 'QuotaLimit');
      }

      out.push({
        externalId: requireString(upstream, ent['@_id'], 'Entitlement@id'),
        accountId,
        contractRef,
        kind: requireString(upstream, ent['@_kind'], 'Entitlement@kind'),
        status: typeof ent['@_status'] === 'string' ? ent['@_status'] : 'ACTIVE',
        featureCode: requireString(upstream, ent.FeatureCode, 'FeatureCode'),
        quotaLimit,
        quotaUnit,
        supportLevel: ent.SupportLevel ? String(ent.SupportLevel) : null,
        maxCaseSeverity: ent.MaxCaseSeverity ? String(ent.MaxCaseSeverity) : null,
        slaResponseMinutes: optionalInt(upstream, ent.SlaResponseMinutes, 'SlaResponseMinutes'),
        effectiveFrom: parseDate(upstream, ent.EffectiveFrom, 'EffectiveFrom'),
        effectiveTo: ent.EffectiveTo ? parseDate(upstream, ent.EffectiveTo, 'EffectiveTo') : null,
      });
    }
  }
  return out;
}

export function parseUsageCsv(upstream: string, text: string): UsageFeedRecord[] {
  let rows: Array<Record<string, string>>;
  try {
    rows = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true }) as Array<Record<string, string>>;
  } catch (err) {
    throw UpstreamError.invalidResponse(upstream, `CSV parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return rows.map((r) => {
    const quantity = optionalInt(upstream, r.quantity, 'quantity');
    if (quantity === null || quantity < 1) {
      throw UpstreamError.invalidResponse(upstream, `row '${r.external_event_id}' has invalid quantity`);
    }
    return {
      externalEventId: requireString(upstream, r.external_event_id, 'external_event_id'),
      accountId: requireString(upstream, r.account_id, 'account_id'),
      metricCode: requireString(upstream, r.metric_code, 'metric_code'),
      quantity,
      source: r.source || 'feed',
      recordedAt: parseDate(upstream, r.recorded_at, 'recorded_at'),
    };
  });
}

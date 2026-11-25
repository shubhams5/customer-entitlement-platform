import { CrmCustomerRecord, ErpEntitlementRecord, UsageFeedRecord } from '../upstream/upstream.types';

export interface CrossValidationResult {
  consistentAccountIds: string[];
  unknownErpAccounts: string[];
  unknownUsageAccounts: string[];
  duplicateCustomerIds: string[];
}

/**
 * CRM is the system of record for accounts: every ERP contract and usage row
 * must reference an account the CRM knows about.
 */
export function crossValidateSources(
  customers: CrmCustomerRecord[],
  entitlements: ErpEntitlementRecord[],
  usage: UsageFeedRecord[],
): CrossValidationResult {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const c of customers) {
    if (seen.has(c.accountId)) {
      duplicates.add(c.accountId);
    }
    seen.add(c.accountId);
  }

  const unknownErp = new Set(entitlements.map((e) => e.accountId).filter((id) => !seen.has(id)));
  const unknownUsage = new Set(usage.map((u) => u.accountId).filter((id) => !seen.has(id)));

  return {
    consistentAccountIds: Array.from(seen).sort(),
    unknownErpAccounts: Array.from(unknownErp).sort(),
    unknownUsageAccounts: Array.from(unknownUsage).sort(),
    duplicateCustomerIds: Array.from(duplicates).sort(),
  };
}

export function isConsistent(result: CrossValidationResult): boolean {
  return (
    result.unknownErpAccounts.length === 0 &&
    result.unknownUsageAccounts.length === 0 &&
    result.duplicateCustomerIds.length === 0
  );
}

type Comparable = string | number | boolean | Date | null | undefined;

function normalize(value: Comparable): string | number | boolean | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  return value ?? null;
}

/** Names of fields whose values differ between `current` and `incoming`. */
export function changedFields<T extends Record<string, Comparable>>(
  current: Partial<Record<keyof T, Comparable>>,
  incoming: T,
): Array<keyof T> {
  return (Object.keys(incoming) as Array<keyof T>).filter(
    (k) => normalize(current[k]) !== normalize(incoming[k]),
  );
}

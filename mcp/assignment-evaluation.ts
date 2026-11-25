const HOURS_48 = 48 * 60 * 60 * 1000;
const DAYS_90 = 90 * 24 * 60 * 60 * 1000;

export interface AssignmentCase {
  id: string;
  accountId: string;
  status: string;
  severity: string;
  createdAt: string;
}

export interface AssignmentCustomerSummary {
  accountId: string;
  tier: string;
  entitlementRenewals: Array<{ featureCode: string; renewalDate: string }> | null;
  partialSections: string[];
}

export interface AssignmentMatch {
  accountId: string;
  caseId: string;
  caseAge: string;
  ageHours: number;
  renewalDate: string;
}

export function assignmentSearchFilters(asOf: Date) {
  return {
    status: 'OPEN' as const,
    severity: 'P1' as const,
    createdBefore: new Date(asOf.getTime() - HOURS_48).toISOString(),
    sort: '-createdAt' as const,
    limit: 25 as const,
  };
}

export function evaluateAssignmentMatches(
  cases: AssignmentCase[],
  customers: AssignmentCustomerSummary[],
  asOf: Date,
): AssignmentMatch[] {
  const cutoff = asOf.getTime() - HOURS_48;
  const renewalDeadline = asOf.getTime() + DAYS_90;
  const summaries = new Map(customers.map((customer) => [customer.accountId, customer]));
  const matches: AssignmentMatch[] = [];

  for (const supportCase of cases) {
    const createdAt = new Date(supportCase.createdAt).getTime();
    if (
      supportCase.status !== 'OPEN' ||
      supportCase.severity !== 'P1' ||
      !Number.isFinite(createdAt) ||
      createdAt >= cutoff
    ) {
      continue;
    }

    const customer = summaries.get(supportCase.accountId);
    if (!customer || customer.tier !== 'Platinum') continue;
    if (customer.partialSections.includes('entitlements') || customer.entitlementRenewals === null) {
      throw new Error(`Entitlement renewal data is unavailable for ${customer.accountId}.`);
    }

    const renewal = customer.entitlementRenewals.find(({ renewalDate }) => {
      const timestamp = new Date(renewalDate).getTime();
      return Number.isFinite(timestamp) && timestamp >= asOf.getTime() && timestamp <= renewalDeadline;
    });
    if (!renewal) continue;

    const ageMinutes = Math.floor((asOf.getTime() - createdAt) / 60_000);
    const days = Math.floor(ageMinutes / 1_440);
    const hours = Math.floor((ageMinutes % 1_440) / 60);
    const minutes = ageMinutes % 60;
    matches.push({
      accountId: customer.accountId,
      caseId: supportCase.id,
      caseAge: `${days}d ${hours}h ${minutes}m`,
      ageHours: Math.round(((asOf.getTime() - createdAt) / 3_600_000) * 100) / 100,
      renewalDate: renewal.renewalDate.slice(0, 10),
    });
  }

  return matches;
}

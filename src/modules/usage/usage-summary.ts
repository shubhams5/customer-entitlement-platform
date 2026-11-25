export interface UsageMetricGroup {
  metricCode: string;
  _sum: { quantity: number | null };
  _count: { _all: number };
}

export interface UsageQuota {
  featureCode: string;
  quotaLimit: number | null;
}

export function buildUsageSummary(
  accountId: string,
  grouped: UsageMetricGroup[],
  quotaEntitlements: UsageQuota[],
  now: Date,
) {
  const metricSet = new Set<string>([
    ...grouped.map((g) => g.metricCode),
    ...quotaEntitlements.map((e) => e.featureCode),
  ]);

  const metrics = Array.from(metricSet)
    .sort()
    .map((metricCode) => {
      const group = grouped.find((item) => item.metricCode === metricCode);
      const entitlement = quotaEntitlements.find((item) => item.featureCode === metricCode);
      const totalQuantity = group?._sum.quantity ?? 0;
      const eventCount = group?._count._all ?? 0;
      const quotaLimit = entitlement?.quotaLimit ?? null;

      return {
        metricCode,
        totalQuantity,
        eventCount,
        quotaLimit,
        remainingQuota: quotaLimit !== null ? Math.max(0, quotaLimit - totalQuantity) : null,
        overQuota: quotaLimit !== null && totalQuantity > quotaLimit,
      };
    });

  return { accountId, generatedAt: now.toISOString(), metrics };
}

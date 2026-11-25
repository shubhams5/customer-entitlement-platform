export interface CrmCustomerRecord {
  accountId: string;
  externalCrmId: string | null;
  name: string;
  primaryEmail: string;
  tier: string;
  status: string;
  region: string;
  annualRecurringRevenue: number | null;
}

export interface ErpEntitlementRecord {
  externalId: string;
  accountId: string;
  contractRef: string;
  kind: string;
  status: string;
  featureCode: string;
  quotaLimit: number | null;
  quotaUnit: string | null;
  supportLevel: string | null;
  maxCaseSeverity: string | null;
  slaResponseMinutes: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface UsageFeedRecord {
  externalEventId: string;
  accountId: string;
  metricCode: string;
  quantity: number;
  source: string;
  recordedAt: Date;
}

export interface CrmAdapter {
  readonly name: string;
  readonly description: string;
  fetchCustomers(): Promise<CrmCustomerRecord[]>;
  /** Resolves null when the CRM has no record for the account. */
  fetchCustomer(accountId: string): Promise<CrmCustomerRecord | null>;
}

export interface ErpAdapter {
  readonly name: string;
  readonly description: string;
  fetchEntitlements(): Promise<ErpEntitlementRecord[]>;
}

export interface UsageFeedAdapter {
  readonly name: string;
  readonly description: string;
  fetchEvents(): Promise<UsageFeedRecord[]>;
}

export interface UpstreamAdapters {
  crm: CrmAdapter;
  erp: ErpAdapter;
  usage: UsageFeedAdapter;
}

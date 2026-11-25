import { ActorContext, hasScope } from '../../common/auth/auth.decorators';
import { Problems } from '../../common/errors/problem-details.exception';

/** Customer fields that require scopes beyond `customers:read` / `customers:write`. */
export const RESTRICTED_CUSTOMER_FIELDS = ['annualRecurringRevenue'] as const;

export interface CustomerView {
  includeArr: boolean;
}

/** View used for webhook payloads and other actor-less projections. */
export const PUBLIC_CUSTOMER_VIEW: CustomerView = { includeArr: false };

export function customerViewFor(actor: ActorContext): CustomerView {
  return { includeArr: hasScope(actor, 'customers:arr:read') };
}

export function assertCanWriteRestrictedFields(
  actor: ActorContext,
  payload: { annualRecurringRevenue?: number | null },
): void {
  if (payload.annualRecurringRevenue !== undefined && !hasScope(actor, 'customers:arr:write')) {
    throw Problems.forbidden(
      "Writing 'annualRecurringRevenue' requires the customers:arr:write scope.",
      'FIELD_WRITE_FORBIDDEN',
    );
  }
}

/** Audit rows are readable with `audit:read`, so restricted values are masked. */
export function redactRestrictedFields<T extends Record<string, unknown>>(payload: T): T {
  const out: Record<string, unknown> = { ...payload };
  for (const field of RESTRICTED_CUSTOMER_FIELDS) {
    if (out[field] !== undefined) {
      out[field] = '[REDACTED]';
    }
  }
  return out as T;
}

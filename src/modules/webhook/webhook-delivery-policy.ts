import { createHmac, timingSafeEqual } from 'crypto';
import { UpstreamError } from '../../common/resilience/upstream-error';

export function computeWebhookSignature(
  signingSecret: string,
  timestampSeconds: number,
  rawJsonBody: string,
): string {
  const digest = createHmac('sha256', signingSecret)
    .update(`${timestampSeconds}.${rawJsonBody}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

export function verifyWebhookSignature(
  signingSecret: string,
  signatureHeader: string,
  rawJsonBody: string,
): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return idx > 0 ? [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()] : [kv, ''];
    }),
  );
  const ts = Number.parseInt(parts.t ?? '', 10);
  const providedHex = parts.v1 ?? '';
  if (!Number.isInteger(ts) || !providedHex) {
    return false;
  }
  const expected = computeWebhookSignature(signingSecret, ts, rawJsonBody);
  const expectedHex = expected.split(',v1=')[1] ?? '';
  const bufA = Buffer.from(providedHex, 'utf8');
  const bufB = Buffer.from(expectedHex, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export type AttemptOutcome =
  | { kind: 'DELIVERED'; responseStatus: number }
  | { kind: 'FAILED'; responseStatus: number | null; error: string; retryable: boolean; retryAfterMs?: number };

/**
 * 2xx acknowledges. 408/425/429/5xx and transport errors are transient and
 * retried; any other 4xx (e.g. 410 Gone, 401 bad signature config) is a
 * permanent rejection, so retrying would only repeat it.
 */
export function classifyHttpOutcome(status: number, retryAfterMs?: number): AttemptOutcome {
  if (status >= 200 && status < 300) {
    return { kind: 'DELIVERED', responseStatus: status };
  }
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  return {
    kind: 'FAILED',
    responseStatus: status,
    error: `Subscriber returned non-2xx HTTP status ${status}`,
    retryable,
    retryAfterMs,
  };
}

export function classifyTransportError(err: unknown): AttemptOutcome {
  if (err instanceof UpstreamError) {
    return { kind: 'FAILED', responseStatus: null, error: err.message, retryable: err.retryable };
  }
  return {
    kind: 'FAILED',
    responseStatus: null,
    error: err instanceof Error ? err.message : String(err),
    retryable: true,
  };
}

export interface RetrySchedule {
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export interface DeliveryTransition {
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
}

/**
 * Next persistent state after an attempt. Retries back off exponentially
 * (base * 2^(attempt-1), capped) and stop once `maxAttempts` is reached,
 * leaving the delivery FAILED for manual re-dispatch.
 */
export function nextDeliveryState(
  outcome: AttemptOutcome,
  attemptCount: number,
  schedule: RetrySchedule,
  now: Date,
): DeliveryTransition {
  if (outcome.kind === 'DELIVERED') {
    return { status: 'DELIVERED', nextAttemptAt: null, deliveredAt: now };
  }
  if (!outcome.retryable || attemptCount >= schedule.maxAttempts) {
    return { status: 'FAILED', nextAttemptAt: null, deliveredAt: null };
  }
  const backoff = Math.min(schedule.retryMaxMs, schedule.retryBaseMs * 2 ** Math.max(0, attemptCount - 1));
  const delay = outcome.retryAfterMs !== undefined ? Math.min(schedule.retryMaxMs, Math.max(backoff, outcome.retryAfterMs)) : backoff;
  return { status: 'PENDING', nextAttemptAt: new Date(now.getTime() + delay), deliveredAt: null };
}

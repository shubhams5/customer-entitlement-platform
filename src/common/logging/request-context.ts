import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface RequestContextStore {
  correlationId: string;
  actorId?: string;
  method?: string;
  path?: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const CORRELATION_HEADERS = ['x-request-id', 'x-correlation-id'] as const;

export function generateCorrelationId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Accepts a caller-supplied correlation ID only when it is a single header
 * value of safe characters; anything else is replaced so log lines and
 * outbound headers can never be injected into.
 */
export function resolveCorrelationId(
  headers: Record<string, string | string[] | undefined>,
): string {
  for (const name of CORRELATION_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && CORRELATION_ID_PATTERN.test(value.trim())) {
      return value.trim();
    }
  }
  return generateCorrelationId();
}

export const RequestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },

  current(): RequestContextStore | undefined {
    return storage.getStore();
  },

  correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },
};

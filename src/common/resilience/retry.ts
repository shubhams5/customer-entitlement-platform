import { isRetryableError, UpstreamError } from './upstream-error';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable?: (err: unknown) => boolean;
  /** Returns a value in [0, 1); injected for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Exponential backoff with "full jitter": delay is uniform in
 * [0, min(maxDelay, base * 2^(attempt-1))]. A server-provided Retry-After
 * overrides the computed delay (still capped by maxDelay).
 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const isRetryable = options.isRetryable ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= options.maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const hinted = err instanceof UpstreamError ? err.retryAfterMs : undefined;
      const delayMs =
        hinted !== undefined
          ? Math.min(hinted, options.maxDelayMs)
          : computeBackoffMs(attempt, options.baseDelayMs, options.maxDelayMs, options.random);
      options.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

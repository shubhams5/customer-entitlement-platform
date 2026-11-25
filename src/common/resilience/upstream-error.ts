export type UpstreamErrorKind =
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_STATUS'
  | 'CIRCUIT_OPEN'
  | 'NOT_FOUND'
  | 'INVALID_RESPONSE';

export class UpstreamError extends Error {
  constructor(
    readonly upstream: string,
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }

  static timeout(upstream: string, timeoutMs: number): UpstreamError {
    return new UpstreamError(upstream, 'TIMEOUT', `${upstream} did not respond within ${timeoutMs}ms`, true);
  }

  static network(upstream: string, cause: unknown): UpstreamError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new UpstreamError(upstream, 'NETWORK', `${upstream} request failed: ${detail}`, true);
  }

  static circuitOpen(upstream: string, retryAfterMs: number): UpstreamError {
    return new UpstreamError(
      upstream,
      'CIRCUIT_OPEN',
      `${upstream} circuit breaker is open; calls short-circuited for ${retryAfterMs}ms`,
      false,
      undefined,
      retryAfterMs,
    );
  }

  static invalidResponse(upstream: string, detail: string): UpstreamError {
    return new UpstreamError(upstream, 'INVALID_RESPONSE', `${upstream} returned an invalid payload: ${detail}`, false);
  }

  static notFound(upstream: string, detail: string): UpstreamError {
    return new UpstreamError(upstream, 'NOT_FOUND', detail, false);
  }

  /**
   * 408/425/429 and 5xx are transient; other 4xx mean the request itself is
   * wrong and repeating it cannot succeed.
   */
  static fromHttpStatus(upstream: string, status: number, retryAfterHeader?: string | null): UpstreamError {
    const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
    return new UpstreamError(
      upstream,
      'HTTP_STATUS',
      `${upstream} responded with HTTP ${status}`,
      retryable,
      status,
      parseRetryAfterMs(retryAfterHeader),
    );
  }
}

export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Errors outside our taxonomy (e.g. programming errors) are never retried. */
export function isRetryableError(err: unknown): boolean {
  return err instanceof UpstreamError && err.retryable;
}

/**
 * Only failures that reflect upstream health trip a breaker; a 404 or a
 * client-side 4xx says nothing about whether the dependency is up.
 */
export function countsAsBreakerFailure(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) {
    return true;
  }
  return err.kind === 'TIMEOUT' || err.kind === 'NETWORK' || (err.kind === 'HTTP_STATUS' && err.retryable);
}

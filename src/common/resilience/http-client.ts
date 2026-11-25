import { Injectable, Logger } from '@nestjs/common';
import { ResiliencePolicy } from '../config/app-config';
import { RequestContext } from '../logging/request-context';
import { CircuitBreakerRegistry } from './circuit-breaker';
import { retryWithBackoff } from './retry';
import { UpstreamError } from './upstream-error';

export interface HttpResult {
  status: number;
  headers: Headers;
  body: string;
  durationMs: number;
}

export interface HttpRequestInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

function isAbortTimeout(err: unknown): boolean {
  const name =
    typeof err === 'object' && err !== null && 'name' in err
      ? err.name
      : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Single HTTP exchange bounded by `timeoutMs` (covers connect, headers, and
 * body). Never throws for HTTP status codes; transport failures are mapped
 * to retryable `UpstreamError`s.
 */
export async function httpRequestOnce(
  upstream: string,
  url: string,
  init: HttpRequestInit,
  timeoutMs: number,
): Promise<HttpResult> {
  const started = Date.now();
  const correlationId = RequestContext.correlationId();
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(correlationId ? { 'x-request-id': correlationId } : {}),
        ...init.headers,
      },
      body: init.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body, durationMs: Date.now() - started };
  } catch (err) {
    if (isAbortTimeout(err)) {
      throw UpstreamError.timeout(upstream, timeoutMs);
    }
    const cause = err instanceof Error && 'cause' in err && err.cause instanceof Error ? err.cause : err;
    throw UpstreamError.network(upstream, cause);
  }
}

/**
 * Read-only upstream client: GET requests are safe to repeat, so they are
 * retried with jittered backoff inside a per-upstream circuit breaker.
 */
@Injectable()
export class ResilientHttpClient {
  private readonly logger = new Logger(ResilientHttpClient.name);
  readonly breakers = new CircuitBreakerRegistry();

  async getText(
    upstream: string,
    url: string,
    policy: ResiliencePolicy,
    accept = 'application/json',
  ): Promise<string> {
    const breaker = this.breakers.get(`upstream:${upstream}`, {
      failureThreshold: policy.breakerFailureThreshold,
      resetTimeoutMs: policy.breakerResetMs,
    });

    return retryWithBackoff(
      (attempt) =>
        breaker.execute(async () => {
          const result = await httpRequestOnce(upstream, url, { headers: { accept } }, policy.timeoutMs);
          this.logger.debug({
            msg: 'upstream.request.completed',
            upstream,
            url,
            attempt,
            status: result.status,
            durationMs: result.durationMs,
          });
          if (result.status === 404) {
            throw UpstreamError.notFound(upstream, `${upstream} resource not found at ${url}`);
          }
          if (result.status < 200 || result.status >= 300) {
            throw UpstreamError.fromHttpStatus(upstream, result.status, result.headers.get('retry-after'));
          }
          return result.body;
        }),
      {
        maxAttempts: policy.maxAttempts,
        baseDelayMs: policy.baseDelayMs,
        maxDelayMs: policy.maxDelayMs,
        onRetry: ({ attempt, delayMs, error }) =>
          this.logger.warn({
            msg: 'upstream.request.retrying',
            upstream,
            url,
            attempt,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }
}

import { CircuitBreaker } from './circuit-breaker';
import type { ResiliencePolicy } from '../config/app-config';
import { ResilientHttpClient } from './http-client';
import { retryWithBackoff } from './retry';
import { UpstreamError } from './upstream-error';

const policy: ResiliencePolicy = {
  timeoutMs: 1000,
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  breakerFailureThreshold: 2,
  breakerResetMs: 1000,
};

describe('upstream resilience', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('opens after repeated transient failures and admits one half-open probe', () => {
    let now = 0;
    const breaker = new CircuitBreaker('crm', {
      failureThreshold: 2,
      resetTimeoutMs: 100,
      now: () => now,
    });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe('OPEN');
    expect(breaker.tryAcquire()).toBe(false);

    now = 100;
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.snapshot().state).toBe('HALF_OPEN');
    expect(breaker.tryAcquire()).toBe(false);
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe('CLOSED');
  });

  it('retries transient errors but returns permanent HTTP failures without retrying', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw UpstreamError.timeout('crm', 50);
        }
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, random: () => 0.5, sleep },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    attempts = 0;
    await expect(
      retryWithBackoff(
        async () => {
          attempts += 1;
          throw UpstreamError.fromHttpStatus('crm', 400);
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep },
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(attempts).toBe(1);
  });

  it('retries upstream 503s, opens the HTTP client breaker, and admits a half-open probe', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('available', { status: 200 }));
    const client = new ResilientHttpClient();
    const retryPolicy = { ...policy, maxAttempts: 2, breakerFailureThreshold: 5 };

    await expect(client.getText('crm', 'http://crm.test/customers', retryPolicy))
      .resolves.toBe('available');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.breakers.snapshots()[0].state).toBe('CLOSED');

    const clockStart = Date.now();
    const time = jest.spyOn(Date, 'now').mockReturnValue(clockStart);
    const failingPolicy = { ...policy, maxAttempts: 1 };
    fetch.mockImplementation(async () => new Response('unavailable', { status: 503 }));
    await expect(client.getText('erp', 'http://erp.test/entitlements', failingPolicy))
      .rejects.toMatchObject({ kind: 'HTTP_STATUS', httpStatus: 503 });
    await expect(client.getText('erp', 'http://erp.test/entitlements', failingPolicy))
      .rejects.toMatchObject({ kind: 'HTTP_STATUS', httpStatus: 503 });
    expect(client.breakers.snapshots().find((breaker) => breaker.name === 'upstream:erp')?.state).toBe('OPEN');

    const attemptsBeforeOpenCircuit = fetch.mock.calls.length;
    await expect(client.getText('erp', 'http://erp.test/entitlements', failingPolicy))
      .rejects.toMatchObject({ kind: 'CIRCUIT_OPEN' });
    expect(fetch).toHaveBeenCalledTimes(attemptsBeforeOpenCircuit);

    time.mockReturnValue(clockStart + failingPolicy.breakerResetMs + 1);
    fetch.mockResolvedValueOnce(new Response('recovered', { status: 200 }));
    await expect(client.getText('erp', 'http://erp.test/entitlements', failingPolicy))
      .resolves.toBe('recovered');
    expect(client.breakers.snapshots().find((breaker) => breaker.name === 'upstream:erp')?.state).toBe('CLOSED');
  });

  it('classifies a fetch timeout as a retryable upstream failure', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('request timed out', 'TimeoutError'));
    const client = new ResilientHttpClient();

    await expect(client.getText('crm', 'http://crm.test/customers', policy))
      .rejects.toMatchObject({ kind: 'TIMEOUT', retryable: true });
  });
});

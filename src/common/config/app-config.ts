import { Global, Injectable, Module } from '@nestjs/common';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function urlFromEnv(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

export interface ResiliencePolicy {
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  breakerFailureThreshold: number;
  breakerResetMs: number;
}

/**
 * Runtime configuration resolved from environment variables once per
 * application instance. Tests override values by setting env vars before
 * the Nest testing module is compiled.
 */
@Injectable()
export class AppConfig {
  readonly fixturesDir = process.env.FIXTURES_DIR?.trim() || 'fixtures';

  readonly upstream = {
    crmBaseUrl: urlFromEnv('CRM_BASE_URL'),
    erpBaseUrl: urlFromEnv('ERP_BASE_URL'),
    usageBaseUrl: urlFromEnv('USAGE_FEED_BASE_URL'),
    policy: {
      timeoutMs: intFromEnv('UPSTREAM_TIMEOUT_MS', 2000),
      maxAttempts: Math.max(1, intFromEnv('UPSTREAM_MAX_ATTEMPTS', 3)),
      baseDelayMs: intFromEnv('UPSTREAM_RETRY_BASE_MS', 100),
      maxDelayMs: intFromEnv('UPSTREAM_RETRY_MAX_MS', 2000),
      breakerFailureThreshold: Math.max(1, intFromEnv('UPSTREAM_BREAKER_THRESHOLD', 5)),
      breakerResetMs: intFromEnv('UPSTREAM_BREAKER_RESET_MS', 30000),
    } satisfies ResiliencePolicy,
  };

  readonly overview = {
    sectionTimeoutMs: intFromEnv('OVERVIEW_SECTION_TIMEOUT_MS', 5000),
  };

  readonly webhooks = {
    allowedPrivateTargets: (process.env.WEBHOOK_ALLOWED_PRIVATE_TARGETS ?? '')
      .split(',')
      .map((target) => target.trim())
      .filter(Boolean),
    timeoutMs: intFromEnv('WEBHOOK_TIMEOUT_MS', 5000),
    maxAttempts: Math.max(1, intFromEnv('WEBHOOK_MAX_ATTEMPTS', 6)),
    retryBaseMs: intFromEnv('WEBHOOK_RETRY_BASE_MS', 30000),
    retryMaxMs: intFromEnv('WEBHOOK_RETRY_MAX_MS', 3600000),
    dispatchIntervalMs: intFromEnv('WEBHOOK_DISPATCH_INTERVAL_MS', 5000),
    batchSize: Math.max(1, intFromEnv('WEBHOOK_DISPATCH_BATCH_SIZE', 20)),
    leaseMs: intFromEnv('WEBHOOK_DISPATCH_LEASE_MS', 60000),
    breakerFailureThreshold: Math.max(1, intFromEnv('WEBHOOK_BREAKER_THRESHOLD', 5)),
    breakerResetMs: intFromEnv('WEBHOOK_BREAKER_RESET_MS', 60000),
  };

  readonly idempotency = {
    ttlMs: intFromEnv('IDEMPOTENCY_TTL_MS', 24 * 60 * 60 * 1000),
    lockMs: intFromEnv('IDEMPOTENCY_LOCK_MS', 30000),
    purgeIntervalMs: intFromEnv('IDEMPOTENCY_PURGE_INTERVAL_MS', 60 * 60 * 1000),
  };
}

@Global()
@Module({
  providers: [AppConfig],
  exports: [AppConfig],
})
export class AppConfigModule {}

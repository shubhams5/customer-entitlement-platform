import { countsAsBreakerFailure, UpstreamError } from './upstream-error';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  now?: () => number;
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  retryAt: number | null;
}

/**
 * Consecutive-failure circuit breaker. After `failureThreshold` failures the
 * circuit opens and calls fail fast; once `resetTimeoutMs` elapses a single
 * probe is allowed (HALF_OPEN). Probe success closes the circuit, probe
 * failure re-opens it for another full reset window.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(
    readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  snapshot(): CircuitBreakerSnapshot {
    this.refreshState();
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      retryAt: this.openedAt !== null ? this.openedAt + this.options.resetTimeoutMs : null,
    };
  }

  /** Milliseconds until a call would be admitted; 0 when admitted now. */
  msUntilRetry(): number {
    this.refreshState();
    if (this.state !== 'OPEN' || this.openedAt === null) {
      return 0;
    }
    return Math.max(0, this.openedAt + this.options.resetTimeoutMs - this.now());
  }

  /**
   * Reserves the right to make one call. Returns false when the circuit is
   * open or a half-open probe is already in flight.
   */
  tryAcquire(): boolean {
    this.refreshState();
    if (this.state === 'OPEN') {
      return false;
    }
    if (this.state === 'HALF_OPEN') {
      if (this.probeInFlight) {
        return false;
      }
      this.probeInFlight = true;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probeInFlight = false;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }

  /** Releases a reserved slot without recording an outcome. */
  releaseNeutral(): void {
    this.probeInFlight = false;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.tryAcquire()) {
      throw UpstreamError.circuitOpen(this.name, this.msUntilRetry());
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      if (countsAsBreakerFailure(err)) {
        this.recordFailure();
      } else {
        this.releaseNeutral();
      }
      throw err;
    }
  }

  private refreshState(): void {
    if (
      this.state === 'OPEN' &&
      this.openedAt !== null &&
      this.now() - this.openedAt >= this.options.resetTimeoutMs
    ) {
      this.state = 'HALF_OPEN';
      this.probeInFlight = false;
    }
  }
}

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  get(name: string, options: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, options);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  snapshots(): CircuitBreakerSnapshot[] {
    return Array.from(this.breakers.values()).map((b) => b.snapshot());
  }
}

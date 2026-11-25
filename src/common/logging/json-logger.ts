import { LoggerService } from '@nestjs/common';
import { RequestContext } from './request-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogSink = (line: string) => void;

const REDACTED_KEYS = new Set([
  'authorization',
  'client_secret',
  'signingsecret',
  'access_token',
  'password',
  'annualrecurringrevenue',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function resolveLevel(raw: string | undefined): LogLevel | 'silent' {
  const normalized = (raw ?? 'info').toLowerCase();
  return normalized in LEVEL_RANK ? (normalized as LogLevel | 'silent') : 'info';
}

/**
 * Newline-delimited JSON logger. Every line carries the correlation ID of the
 * request being served (via AsyncLocalStorage) so logs, audit rows, Problem
 * Details `traceId`, and outbound upstream calls can be joined.
 */
export class JsonLogger implements LoggerService {
  private readonly minRank: number;

  constructor(
    level: string | undefined = process.env.LOG_LEVEL,
    private readonly sink: LogSink = (line) => process.stdout.write(`${line}\n`),
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.minRank = LEVEL_RANK[resolveLevel(level)];
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.write('info', message, optional);
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, optional);
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, optional);
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }

  private write(level: LogLevel, message: unknown, optional: unknown[]): void {
    if (LEVEL_RANK[level] < this.minRank) {
      return;
    }

    // Nest passes (message, context) or (message, stack, context) for errors.
    const params = [...optional];
    const context = typeof params[params.length - 1] === 'string' ? (params.pop() as string) : undefined;
    const stack = level === 'error' && typeof params[0] === 'string' ? (params.shift() as string) : undefined;

    const ctx = RequestContext.current();
    const fields =
      message !== null && typeof message === 'object' && !(message instanceof Error)
        ? (redact(message) as Record<string, unknown>)
        : { msg: message instanceof Error ? message.message : String(message) };

    const entry: Record<string, unknown> = {
      ts: this.clock().toISOString(),
      level,
      ...(context ? { context } : {}),
      ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
      ...(ctx?.actorId ? { actorId: ctx.actorId } : {}),
      ...fields,
      ...(stack ? { stack } : {}),
    };

    this.sink(JSON.stringify(entry));
  }
}

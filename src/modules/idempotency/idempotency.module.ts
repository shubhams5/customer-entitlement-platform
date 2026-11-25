import {
  CallHandler,
  createParamDecorator,
  ExecutionContext,
  Global,
  Injectable,
  Logger,
  Module,
  NestInterceptor,
  OnModuleDestroy,
  OnModuleInit,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { from, Observable, of } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { ActorContext } from '../../common/auth/auth.decorators';
import { AppConfig } from '../../common/config/app-config';
import { Problems } from '../../common/errors/problem-details.exception';
import { PrismaService } from '../../common/prisma/prisma.module';

export const IDEMPOTENT_ROUTE_KEY = 'isIdempotentRoute';
export const Idempotent = () => SetMetadata(IDEMPOTENT_ROUTE_KEY, true);

type IdempotentRequest = FastifyRequest & { actor?: ActorContext; idempotencyKey?: string };

/** Validated `Idempotency-Key` of the current request (undefined when absent). */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined =>
    ctx.switchToHttp().getRequest<IdempotentRequest>().idempotencyKey,
);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) {
        sorted[k] = canonicalize(v);
      }
    }
    return sorted;
  }
  return value;
}

export function hashRequestBody(body: unknown): string {
  const normalized = JSON.stringify(canonicalize(body ?? {}));
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Fingerprint of everything that can change the response: the payload and
 * the caller's granted scopes (field-level authorization depends on them).
 */
export function requestFingerprint(body: unknown, scopes: readonly string[]): string {
  return hashRequestBody({ body: body ?? {}, scopes: [...scopes].sort() });
}

export type BeginIdempotencyResult =
  | { kind: 'REPLAY'; statusCode: number; body: unknown; etag: string | null }
  | { kind: 'EXECUTE'; recordId: string };

@Injectable()
export class IdempotencyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyService.name);
  private purgeTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const interval = this.config.idempotency.purgeIntervalMs;
    if (interval > 0) {
      this.purgeTimer = setInterval(() => {
        this.purgeExpired().catch((err: unknown) =>
          this.logger.warn({
            msg: 'idempotency.purge.failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }, interval);
      this.purgeTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
    }
  }

  async beginExecution(
    params: {
      key: string;
      method: string;
      routePath: string;
      actorId: string;
      requestHash: string;
    },
    now = new Date(),
  ): Promise<BeginIdempotencyResult> {
    const composite = {
      key_method_routePath_actorId: {
        key: params.key,
        method: params.method,
        routePath: params.routePath,
        actorId: params.actorId,
      },
    };

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: composite,
    });

    if (existing && existing.expiresAt > now) {
      if (existing.requestHash !== params.requestHash) {
        throw Problems.conflict(
          `Idempotency-Key '${params.key}' was already used with a different request payload or authorization context.`,
          'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
        );
      }

      if (existing.status === 'IN_PROGRESS') {
        const lockExpired = existing.lockExpiresAt !== null && existing.lockExpiresAt <= now;
        if (!lockExpired) {
          throw Problems.conflict(
            `A request with Idempotency-Key '${params.key}' is currently in progress.`,
            'IDEMPOTENCY_KEY_IN_PROGRESS',
          );
        }
        // The previous holder died mid-request; take over its lock atomically.
        const taken = await this.prisma.idempotencyRecord.updateMany({
          where: { id: existing.id, status: 'IN_PROGRESS', lockExpiresAt: existing.lockExpiresAt },
          data: { lockExpiresAt: new Date(now.getTime() + this.config.idempotency.lockMs) },
        });
        if (taken.count === 1) {
          this.logger.warn({ msg: 'idempotency.lock.taken_over', key: params.key, recordId: existing.id });
          return { kind: 'EXECUTE', recordId: existing.id };
        }
        throw Problems.conflict(
          `A request with Idempotency-Key '${params.key}' is currently in progress.`,
          'IDEMPOTENCY_KEY_IN_PROGRESS',
        );
      }

      return {
        kind: 'REPLAY',
        statusCode: existing.responseStatus ?? 200,
        body: existing.responseBody ? JSON.parse(existing.responseBody) : null,
        etag: existing.responseEtag,
      };
    }

    if (existing && existing.expiresAt <= now) {
      await this.prisma.idempotencyRecord.deleteMany({ where: { id: existing.id } });
    }

    try {
      const created = await this.prisma.idempotencyRecord.create({
        data: {
          key: params.key,
          method: params.method,
          routePath: params.routePath,
          actorId: params.actorId,
          requestHash: params.requestHash,
          status: 'IN_PROGRESS',
          lockExpiresAt: new Date(now.getTime() + this.config.idempotency.lockMs),
          expiresAt: new Date(now.getTime() + this.config.idempotency.ttlMs),
        },
      });
      return { kind: 'EXECUTE', recordId: created.id };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Problems.conflict(
          `Concurrent request detected for Idempotency-Key '${params.key}'.`,
          'IDEMPOTENCY_KEY_IN_PROGRESS',
        );
      }
      throw err;
    }
  }

  async completeExecution(
    recordId: string,
    responseStatus: number,
    responseBody: unknown,
    responseEtag?: string,
  ): Promise<void> {
    await this.prisma.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        status: 'COMPLETED',
        responseStatus,
        responseBody: JSON.stringify(responseBody ?? null),
        responseEtag: responseEtag ?? null,
        lockExpiresAt: null,
      },
    });
  }

  async abortExecution(recordId: string): Promise<void> {
    await this.prisma.idempotencyRecord.deleteMany({
      where: { id: recordId, status: 'IN_PROGRESS' },
    });
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const res = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    if (res.count > 0) {
      this.logger.log({ msg: 'idempotency.purge.completed', purged: res.count });
    }
    return res.count;
  }
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(
      IDEMPOTENT_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!isIdempotent) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentRequest>();
    const reply = http.getResponse<FastifyReply>();

    const rawHeader = request.headers['idempotency-key'];
    if (rawHeader === undefined) {
      reply.header('idempotency-replayed', 'false');
      return next.handle();
    }

    if (Array.isArray(rawHeader) || rawHeader.trim().length < 8 || rawHeader.trim().length > 128) {
      throw Problems.badRequest(
        'Header "Idempotency-Key" must be a single string between 8 and 128 characters.',
        'INVALID_IDEMPOTENCY_KEY',
      );
    }

    const key = rawHeader.trim();
    request.idempotencyKey = key;
    // Concrete path (not the route pattern) so one key cannot replay across
    // different resources, e.g. comments on two different cases.
    const routePath = request.url.split('?')[0];
    const actorId = request.actor?.actorId ?? 'anonymous';
    const requestHash = requestFingerprint(request.body, request.actor?.scopes ?? []);

    return from(
      this.idempotencyService.beginExecution({
        key,
        method: request.method.toUpperCase(),
        routePath,
        actorId,
        requestHash,
      }),
    ).pipe(
      mergeMap((decision) => {
        if (decision.kind === 'REPLAY') {
          reply.status(decision.statusCode);
          reply.header('idempotency-replayed', 'true');
          if (decision.etag) {
            reply.header('etag', decision.etag);
          }
          return of(decision.body);
        }

        return next.handle().pipe(
          mergeMap((body) =>
            from(
              (async () => {
                const statusCode = reply.statusCode;
                const etagHeader = reply.getHeader('etag');
                await this.idempotencyService.completeExecution(
                  decision.recordId,
                  statusCode,
                  body,
                  typeof etagHeader === 'string' ? etagHeader : undefined,
                );
                reply.header('idempotency-replayed', 'false');
                return body;
              })(),
            ),
          ),
          catchError((err) =>
            from(this.idempotencyService.abortExecution(decision.recordId)).pipe(
              mergeMap(() => {
                throw err;
              }),
            ),
          ),
        );
      }),
    );
  }
}

@Global()
@Module({
  providers: [IdempotencyService, IdempotencyInterceptor],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}

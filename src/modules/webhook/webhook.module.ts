import {
  Body,
  Controller,
  Get,
  Global,
  HttpCode,
  HttpStatus,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Prisma, WebhookDelivery, WebhookEndpoint } from '@prisma/client';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { randomBytes, randomUUID } from 'crypto';
import { FastifyReply } from 'fastify';
import {
  ActorContext,
  CurrentActor,
  RequireScopes,
} from '../../common/auth/auth.decorators';
import { AppConfig } from '../../common/config/app-config';
import { formatEtag } from '../../common/concurrency/etag.util';
import { Problems } from '../../common/errors/problem-details.exception';
import { generateCorrelationId, RequestContext } from '../../common/logging/request-context';
import {
  buildCursorPage,
  decodeCursor,
  PaginatedResult,
  PaginationQueryDto,
} from '../../common/pagination/cursor-pagination';
import { PrismaService } from '../../common/prisma/prisma.module';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../common/resilience/circuit-breaker';
import { parseRetryAfterMs } from '../../common/resilience/upstream-error';
import { AuditService } from '../audit/audit.module';
import { Idempotent } from '../idempotency/idempotency.module';
import {
  parseWebhookTarget,
  UnsafeWebhookTargetError,
  webhookHttpRequestOnce,
} from './webhook-network';
import {
  AttemptOutcome,
  classifyHttpOutcome,
  classifyTransportError,
  computeWebhookSignature,
  nextDeliveryState,
} from './webhook-delivery-policy';

export { computeWebhookSignature, verifyWebhookSignature } from './webhook-delivery-policy';

export const WEBHOOK_EVENT_TYPES = [
  'customer.created',
  'customer.updated',
  'entitlement.created',
  'entitlement.updated',
  'usage.threshold.exceeded',
  'case.created',
  'case.updated',
  'case.escalated',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEventEnvelope {
  id: string;
  specVersion: '1.0';
  type: WebhookEventType;
  accountId: string | null;
  occurredAt: string;
  data: Record<string, unknown>;
}

export class CreateWebhookEndpointDto {
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  url: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  subscribedEvents: WebhookEventType[];

  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  signingSecret?: string;
}

export class ListWebhookDeliveriesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  endpointId?: string;

  @IsOptional()
  @IsIn(WEBHOOK_EVENT_TYPES)
  eventType?: WebhookEventType;

  @IsOptional()
  @IsIn(['PENDING', 'DELIVERED', 'FAILED'])
  status?: 'PENDING' | 'DELIVERED' | 'FAILED';
}

type DeliveryWithEndpoint = WebhookDelivery & {
  endpoint: WebhookEndpoint;
  outboxEvent: { correlationId: string | null } | null;
};

function parseSubscribedEvents(json: string): WebhookEventType[] {
  try {
    const parsed = JSON.parse(json) as WebhookEventType[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function toDeliveryDto(row: WebhookDelivery) {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventType: row.eventType as WebhookEventType,
    accountId: row.accountId,
    status: row.status as 'PENDING' | 'DELIVERED' | 'FAILED',
    signatureHeader: row.signatureHeader,
    attemptCount: row.attemptCount,
    responseStatus: row.responseStatus,
    lastError: row.lastError,
    payload: JSON.parse(row.payloadJson) as WebhookEventEnvelope,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Performs one signed HTTP attempt for a delivery and persists the outcome.
 * Shared by the background dispatcher and the manual dispatch endpoint so
 * both apply identical signing, classification, and retry scheduling.
 */
@Injectable()
export class WebhookDeliveryExecutor {
  private readonly logger = new Logger('WebhookDelivery');
  readonly breakers = new CircuitBreakerRegistry();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  breakerFor(endpointId: string): CircuitBreaker {
    return this.breakers.get(`webhook:${endpointId}`, {
      failureThreshold: this.config.webhooks.breakerFailureThreshold,
      resetTimeoutMs: this.config.webhooks.breakerResetMs,
    });
  }

  /** Leases a not-yet-delivered row; manual retries may also claim FAILED rows. */
  async claim(deliveryId: string, now: Date, allowFailed = false): Promise<boolean> {
    const res = await this.prisma.webhookDelivery.updateMany({
      where: {
        id: deliveryId,
        status: allowFailed ? { not: 'DELIVERED' } : 'PENDING',
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { lockedUntil: new Date(now.getTime() + this.config.webhooks.leaseMs) },
    });
    return res.count === 1;
  }

  async release(deliveryId: string, data: Prisma.WebhookDeliveryUpdateInput = {}): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { ...data, lockedUntil: null },
    });
  }

  async attempt(delivery: DeliveryWithEndpoint, trigger: 'manual' | 'scheduled'): Promise<WebhookDelivery> {
    const now = new Date();
    const breaker = this.breakerFor(delivery.endpointId);
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const signatureHeader = computeWebhookSignature(
      delivery.endpoint.signingSecret,
      timestampSeconds,
      delivery.payloadJson,
    );

    let outcome: AttemptOutcome;
    const started = Date.now();
    try {
      const result = await webhookHttpRequestOnce(
        delivery.endpoint.url,
        {
          headers: {
            'content-type': 'application/json',
            'x-webhook-id': delivery.id,
            'x-webhook-event': delivery.eventType,
            'x-webhook-timestamp': String(timestampSeconds),
            'x-webhook-signature': signatureHeader,
          },
          body: delivery.payloadJson,
        },
        this.config.webhooks.timeoutMs,
        this.config.webhooks.allowedPrivateTargets,
      );
      outcome = classifyHttpOutcome(result.status, parseRetryAfterMs(result.headers.get('retry-after')));
    } catch (err) {
      outcome =
        err instanceof UnsafeWebhookTargetError
          ? { kind: 'FAILED', responseStatus: null, error: err.message, retryable: false }
          : classifyTransportError(err);
    }

    if (outcome.kind === 'DELIVERED') {
      breaker.recordSuccess();
    } else if (outcome.retryable) {
      breaker.recordFailure();
    } else {
      breaker.releaseNeutral();
    }

    const attemptCount = delivery.attemptCount + 1;
    const transition = nextDeliveryState(outcome, attemptCount, this.config.webhooks, new Date());

    const updated = await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: transition.status,
        attemptCount,
        responseStatus: outcome.responseStatus,
        lastError: outcome.kind === 'DELIVERED' ? null : outcome.error,
        nextAttemptAt: transition.nextAttemptAt,
        deliveredAt: transition.deliveredAt ?? delivery.deliveredAt,
        signatureHeader,
        timestampHeader: timestampSeconds,
        lockedUntil: null,
      },
    });

    const logEntry = {
      msg: 'webhook.delivery.attempted',
      trigger,
      deliveryId: delivery.id,
      endpointId: delivery.endpointId,
      eventType: delivery.eventType,
      attempt: attemptCount,
      status: transition.status,
      responseStatus: outcome.responseStatus,
      durationMs: Date.now() - started,
      nextAttemptAt: transition.nextAttemptAt?.toISOString() ?? null,
      breaker: breaker.snapshot().state,
      ...(outcome.kind === 'FAILED' ? { error: outcome.error } : {}),
    };
    if (outcome.kind === 'DELIVERED') {
      this.logger.log(logEntry);
    } else {
      this.logger.warn(logEntry);
    }

    return updated;
  }
}

@Injectable()
export class WebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly executor: WebhookDeliveryExecutor,
    private readonly config: AppConfig,
  ) {}

  async createEndpoint(dto: CreateWebhookEndpointDto, actor: ActorContext) {
    let target: URL;
    try {
      target = parseWebhookTarget(dto.url, this.config.webhooks.allowedPrivateTargets);
    } catch (err) {
      if (err instanceof UnsafeWebhookTargetError) {
        throw Problems.badRequest(err.message, 'UNSAFE_WEBHOOK_TARGET');
      }
      throw err;
    }
    const signingSecret =
      dto.signingSecret ?? `whsec_${randomBytes(24).toString('hex')}`;
    const uniqueEvents = Array.from(new Set(dto.subscribedEvents));

    const created = await this.prisma.$transaction(async (tx) => {
      const endpoint = await tx.webhookEndpoint.create({
        data: {
          url: target.href,
          description: dto.description ?? null,
          signingSecret,
          subscribedEventsJson: JSON.stringify(uniqueEvents),
          active: true,
        },
      });
      await this.auditService.record(
        {
          actor,
          action: 'webhook.endpoint.created',
          entityType: 'WebhookEndpoint',
          entityId: endpoint.id,
          metadata: { url: endpoint.url, subscribedEvents: uniqueEvents },
        },
        tx,
      );
      return endpoint;
    });

    return {
      ...this.toEndpointDto(created),
      signingSecret,
    };
  }

  async listEndpoints(query: PaginationQueryDto): Promise<PaginatedResult<ReturnType<WebhookService['toEndpointDto']>>> {
    const limit = query.limit ?? 20;
    const cursorId = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = await this.prisma.webhookEndpoint.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const page = buildCursorPage(rows, limit);
    return {
      data: page.data.map((r) => this.toEndpointDto(r)),
      page: page.page,
    };
  }

  /**
   * Transactional outbox write: must be called with the transaction client of
   * the state change it describes, so the event exists if and only if that
   * change commits. Fan-out to subscribed endpoints happens in the same
   * transaction; HTTP delivery happens later from the delivery rows.
   */
  async emitEvent(
    params: {
      eventType: WebhookEventType;
      accountId?: string | null;
      data: Record<string, unknown>;
    },
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const now = new Date();
    const envelope: WebhookEventEnvelope = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      specVersion: '1.0',
      type: params.eventType,
      accountId: params.accountId ?? null,
      occurredAt: now.toISOString(),
      data: params.data,
    };
    const payloadJson = JSON.stringify(envelope);

    await tx.outboxEvent.create({
      data: {
        id: envelope.id,
        eventType: params.eventType,
        accountId: envelope.accountId,
        payloadJson,
        correlationId: RequestContext.correlationId() ?? null,
      },
    });

    const endpoints = await tx.webhookEndpoint.findMany({ where: { active: true } });
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    for (const ep of endpoints) {
      if (!parseSubscribedEvents(ep.subscribedEventsJson).includes(params.eventType)) {
        continue;
      }
      await tx.webhookDelivery.create({
        data: {
          endpointId: ep.id,
          outboxEventId: envelope.id,
          eventType: params.eventType,
          accountId: envelope.accountId,
          status: 'PENDING',
          signatureHeader: computeWebhookSignature(ep.signingSecret, timestampSeconds, payloadJson),
          timestampHeader: timestampSeconds,
          payloadJson,
          attemptCount: 0,
          nextAttemptAt: now,
        },
      });
    }

    return envelope.id;
  }

  async listDeliveries(query: ListWebhookDeliveriesQueryDto) {
    const limit = query.limit ?? 20;
    const cursorId = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = await this.prisma.webhookDelivery.findMany({
      where: {
        ...(query.endpointId ? { endpointId: query.endpointId } : {}),
        ...(query.eventType ? { eventType: query.eventType } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const page = buildCursorPage(rows, limit);
    return {
      data: page.data.map((r) => toDeliveryDto(r)),
      page: page.page,
    };
  }

  /**
   * Operator-triggered attempt. Bypasses the schedule and the endpoint's
   * open circuit (the operator is explicitly probing), but still holds the
   * row lease so it never races the background dispatcher. Delivered rows
   * are returned unchanged to prevent replaying an acknowledged event.
   */
  async dispatchDelivery(deliveryId: string, actor: ActorContext) {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: true, outboxEvent: { select: { correlationId: true } } },
    });

    if (!delivery) {
      throw Problems.notFound(
        `Webhook delivery '${deliveryId}' was not found.`,
        'WEBHOOK_DELIVERY_NOT_FOUND',
      );
    }

    if (delivery.status === 'DELIVERED') {
      await this.auditService.record({
        actor,
        accountId: delivery.accountId,
        action: 'webhook.delivery.replay_blocked',
        entityType: 'WebhookDelivery',
        entityId: delivery.id,
        metadata: { status: delivery.status, attemptCount: delivery.attemptCount },
      });
      return toDeliveryDto(delivery);
    }

    if (!(await this.executor.claim(deliveryId, new Date(), true))) {
      throw Problems.conflict(
        `Webhook delivery '${deliveryId}' is currently being attempted by another worker.`,
        'DELIVERY_IN_FLIGHT',
      );
    }

    let updated: WebhookDelivery;
    try {
      updated = await this.executor.attempt(delivery, 'manual');
    } catch (err) {
      await this.executor.release(deliveryId).catch(() => undefined);
      throw err;
    }

    await this.auditService.record({
      actor,
      accountId: delivery.accountId,
      action: 'webhook.delivery.dispatched',
      entityType: 'WebhookDelivery',
      entityId: delivery.id,
      metadata: {
        status: updated.status,
        responseStatus: updated.responseStatus,
        attemptCount: updated.attemptCount,
      },
    });

    return toDeliveryDto(updated);
  }

  private toEndpointDto(row: WebhookEndpoint) {
    return {
      id: row.id,
      url: row.url,
      description: row.description,
      subscribedEvents: parseSubscribedEvents(row.subscribedEventsJson),
      active: row.active,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * Background relay: polls due PENDING deliveries, leases each row, and
 * performs one attempt. Failed attempts are rescheduled with backoff by
 * `nextDeliveryState`; open endpoint circuits defer work without consuming
 * an attempt.
 */
@Injectable()
export class WebhookDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly executor: WebhookDeliveryExecutor,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.webhooks.dispatchIntervalMs;
    if (interval <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      if (!this.running) {
        void this.runOnce().catch((err: unknown) =>
          this.logger.error({
            msg: 'webhook.dispatcher.tick_failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }, interval);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.running?.catch(() => undefined);
  }

  /** Processes one batch of due deliveries; returns the number attempted. */
  runOnce(now = new Date()): Promise<number> {
    if (this.running) {
      return this.running;
    }
    this.running = this.processBatch(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async processBatch(now: Date): Promise<number> {
    const due = await this.prisma.webhookDelivery.findMany({
      where: {
        status: 'PENDING',
        nextAttemptAt: { lte: now },
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      include: { endpoint: true, outboxEvent: { select: { correlationId: true } } },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: this.config.webhooks.batchSize,
    });

    let attempted = 0;
    for (const delivery of due) {
      const correlationId = delivery.outboxEvent?.correlationId ?? generateCorrelationId();
      await RequestContext.run({ correlationId }, async () => {
        if (!(await this.executor.claim(delivery.id, now))) {
          return;
        }
        try {
          if (!delivery.endpoint.active) {
            await this.executor.release(delivery.id, {
              status: 'FAILED',
              nextAttemptAt: null,
              lastError: 'Webhook endpoint is inactive',
            });
            return;
          }
          const breaker = this.executor.breakerFor(delivery.endpointId);
          if (!breaker.tryAcquire()) {
            const waitMs = Math.max(breaker.msUntilRetry(), 1000);
            await this.executor.release(delivery.id, {
              nextAttemptAt: new Date(Date.now() + waitMs),
            });
            this.logger.warn({
              msg: 'webhook.delivery.deferred_circuit_open',
              deliveryId: delivery.id,
              endpointId: delivery.endpointId,
              waitMs,
            });
            return;
          }
          await this.executor.attempt(delivery, 'scheduled');
          attempted += 1;
        } catch (err) {
          await this.executor.release(delivery.id).catch(() => undefined);
          this.logger.error({
            msg: 'webhook.delivery.attempt_crashed',
            deliveryId: delivery.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
    return attempted;
  }
}

@Controller('v1/webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Get('endpoints')
  @RequireScopes('webhooks:read')
  listEndpoints(@Query() query: PaginationQueryDto) {
    return this.webhookService.listEndpoints(query);
  }

  @Post('endpoints')
  @RequireScopes('webhooks:write')
  @Idempotent()
  async createEndpoint(
    @Body() dto: CreateWebhookEndpointDto,
    @CurrentActor() actor: ActorContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const created = await this.webhookService.createEndpoint(dto, actor);
    reply.header('etag', formatEtag(created.version));
    return created;
  }

  @Get('deliveries')
  @RequireScopes('webhooks:read')
  listDeliveries(@Query() query: ListWebhookDeliveriesQueryDto) {
    return this.webhookService.listDeliveries(query);
  }

  @Post('deliveries/:deliveryId/dispatch')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('webhooks:write')
  dispatchDelivery(
    @Param('deliveryId') deliveryId: string,
    @CurrentActor() actor: ActorContext,
  ) {
    return this.webhookService.dispatchDelivery(deliveryId, actor);
  }
}

@Global()
@Module({
  controllers: [WebhookController],
  providers: [WebhookService, WebhookDeliveryExecutor, WebhookDispatcher],
  exports: [WebhookService, WebhookDispatcher],
})
export class WebhookModule {}

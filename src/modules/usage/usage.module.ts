import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import { UsageEvent } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ActorContext,
  CurrentActor,
  RequireScopes,
} from '../../common/auth/auth.decorators';
import { Problems } from '../../common/errors/problem-details.exception';
import {
  buildCursorPage,
  decodeCursor,
  PaginationQueryDto,
} from '../../common/pagination/cursor-pagination';
import { PrismaService } from '../../common/prisma/prisma.module';
import { AuditService } from '../audit/audit.module';
import { CustomerModule, CustomerService } from '../customer/customer.module';
import { Idempotent } from '../idempotency/idempotency.module';
import { WebhookService } from '../webhook/webhook.module';
import { buildUsageSummary } from './usage-summary';

export class ListUsageEventsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  metricCode?: string;
}

export class UsageSummaryQueryDto {
  @IsString()
  @IsNotEmpty()
  accountId: string;

  @IsOptional()
  @IsString()
  metricCode?: string;
}

export class CreateUsageEventDto {
  @IsString()
  @MinLength(3)
  @MaxLength(128)
  externalEventId: string;

  @IsString()
  accountId: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  metricCode: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  source?: string;

  @IsOptional()
  @IsDateString()
  recordedAt?: string;
}

@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customerService: CustomerService,
    private readonly auditService: AuditService,
    private readonly webhookService: WebhookService,
  ) {}

  async listEvents(query: ListUsageEventsQueryDto) {
    const limit = query.limit ?? 20;
    const cursorId = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = await this.prisma.usageEvent.findMany({
      where: {
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.metricCode ? { metricCode: query.metricCode } : {}),
      },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const page = buildCursorPage(rows, limit);
    return {
      data: page.data.map((r) => this.toDto(r)),
      page: page.page,
    };
  }

  async recordEvent(dto: CreateUsageEventDto, actor: ActorContext) {
    await this.customerService.findByAccountIdOrThrow(dto.accountId);

    const duplicate = await this.prisma.usageEvent.findUnique({
      where: { externalEventId: dto.externalEventId },
    });
    if (duplicate) {
      throw Problems.conflict(
        `Usage event with externalEventId '${dto.externalEventId}' has already been recorded.`,
        'DUPLICATE_USAGE_EVENT',
      );
    }

    const now = new Date();
    const recordedAt = dto.recordedAt ? new Date(dto.recordedAt) : now;

    return this.prisma.$transaction(async (tx) => {
      const event = await tx.usageEvent.create({
        data: {
          externalEventId: dto.externalEventId,
          accountId: dto.accountId,
          metricCode: dto.metricCode,
          quantity: dto.quantity,
          source: dto.source ?? 'api',
          recordedAt,
        },
      });

      const agg = await tx.usageEvent.aggregate({
        where: { accountId: dto.accountId, metricCode: dto.metricCode },
        _sum: { quantity: true },
      });
      const currentUsage = agg._sum.quantity ?? 0;

      const activeQuota = await tx.entitlement.findFirst({
        where: {
          accountId: dto.accountId,
          featureCode: dto.metricCode,
          kind: 'METERED_QUOTA',
          status: 'ACTIVE',
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        orderBy: { createdAt: 'desc' },
      });

      const quotaLimit = activeQuota?.quotaLimit ?? null;
      const utilizationPct =
        quotaLimit && quotaLimit > 0
          ? Number(((currentUsage / quotaLimit) * 100).toFixed(2))
          : null;
      const overQuota = quotaLimit !== null ? currentUsage > quotaLimit : false;

      await this.auditService.record(
        {
          actor,
          accountId: dto.accountId,
          action: 'usage.recorded',
          entityType: 'UsageEvent',
          entityId: event.id,
          metadata: {
            externalEventId: dto.externalEventId,
            metricCode: dto.metricCode,
            quantity: dto.quantity,
            currentUsage,
            quotaLimit,
            overQuota,
          },
        },
        tx,
      );

      if (utilizationPct !== null && utilizationPct >= 80) {
        await this.webhookService.emitEvent(
          {
            eventType: 'usage.threshold.exceeded',
            accountId: dto.accountId,
            data: {
              metricCode: dto.metricCode,
              currentUsage,
              quotaLimit,
              utilizationPct,
              overQuota,
              triggerEventId: event.id,
            },
          },
          tx,
        );
      }

      return {
        event: this.toDto(event),
        quotaStatus: {
          metricCode: dto.metricCode,
          currentUsage,
          quotaLimit,
          utilizationPct,
          overQuota,
        },
      };
    });
  }

  async getSummary(query: UsageSummaryQueryDto) {
    await this.customerService.findByAccountIdOrThrow(query.accountId);
    const now = new Date();

    const grouped = await this.prisma.usageEvent.groupBy({
      by: ['metricCode'],
      where: {
        accountId: query.accountId,
        ...(query.metricCode ? { metricCode: query.metricCode } : {}),
      },
      _sum: { quantity: true },
      _count: { _all: true },
    });

    const quotaEntitlements = await this.prisma.entitlement.findMany({
      where: {
        accountId: query.accountId,
        kind: 'METERED_QUOTA',
        status: 'ACTIVE',
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        ...(query.metricCode ? { featureCode: query.metricCode } : {}),
      },
    });

    return buildUsageSummary(query.accountId, grouped, quotaEntitlements, now);
  }

  toDto(row: UsageEvent) {
    return {
      id: row.id,
      externalEventId: row.externalEventId,
      accountId: row.accountId,
      metricCode: row.metricCode,
      quantity: row.quantity,
      source: row.source,
      recordedAt: row.recordedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

@Controller('v1/usage')
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  @Get('events')
  @RequireScopes('usage:read')
  listEvents(@Query() query: ListUsageEventsQueryDto) {
    return this.usageService.listEvents(query);
  }

  @Post('events')
  @RequireScopes('usage:write')
  @Idempotent()
  recordEvent(
    @Body() dto: CreateUsageEventDto,
    @CurrentActor() actor: ActorContext,
  ) {
    return this.usageService.recordEvent(dto, actor);
  }

  @Get('summary')
  @RequireScopes('usage:read')
  getSummary(@Query() query: UsageSummaryQueryDto) {
    return this.usageService.getSummary(query);
  }
}

@Module({
  imports: [CustomerModule],
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Entitlement } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { FastifyReply } from 'fastify';
import {
  ActorContext,
  CurrentActor,
  RequireScopes,
} from '../../common/auth/auth.decorators';
import {
  assertExpectedVersion,
  formatEtag,
  parseIfMatchVersion,
} from '../../common/concurrency/etag.util';
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

export const ENTITLEMENT_KINDS = [
  'BOOLEAN_FEATURE',
  'METERED_QUOTA',
  'SUPPORT_PLAN',
] as const;
export type EntitlementKind = (typeof ENTITLEMENT_KINDS)[number];

export const ENTITLEMENT_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

export const SUPPORT_LEVELS = ['STANDARD', 'PRIORITY', 'MISSION_CRITICAL'] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

export const CASE_SEVERITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type CaseSeverity = (typeof CASE_SEVERITIES)[number];

const SEVERITY_RANK: Record<CaseSeverity, number> = {
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

export class ListEntitlementsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  featureCode?: string;

  @IsOptional()
  @IsIn(ENTITLEMENT_STATUSES)
  status?: EntitlementStatus;
}

export class CreateEntitlementDto {
  @IsString()
  accountId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contractRef?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  featureCode: string;

  @IsIn(ENTITLEMENT_KINDS)
  kind: EntitlementKind;

  @IsOptional()
  @IsIn(ENTITLEMENT_STATUSES)
  status?: EntitlementStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  quotaLimit?: number;

  @IsOptional()
  @IsString()
  quotaUnit?: string;

  @IsOptional()
  @IsIn(SUPPORT_LEVELS)
  supportLevel?: SupportLevel;

  @IsOptional()
  @IsIn(CASE_SEVERITIES)
  maxCaseSeverity?: CaseSeverity;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  slaResponseMinutes?: number;

  @IsDateString()
  effectiveFrom: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;
}

export class UpdateEntitlementDto {
  @IsOptional()
  @IsIn(ENTITLEMENT_STATUSES)
  status?: EntitlementStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  quotaLimit?: number;

  @IsOptional()
  @IsIn(SUPPORT_LEVELS)
  supportLevel?: SupportLevel;

  @IsOptional()
  @IsIn(CASE_SEVERITIES)
  maxCaseSeverity?: CaseSeverity;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  slaResponseMinutes?: number;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;
}

export class EvaluateEntitlementDto {
  @IsString()
  accountId: string;

  @IsString()
  featureCode: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  requestedQuantity?: number = 1;

  @IsOptional()
  @IsIn(CASE_SEVERITIES)
  requestedSeverity?: CaseSeverity;

  @IsOptional()
  @IsDateString()
  at?: string;
}

export interface EntitlementDecision {
  allowed: boolean;
  reasonCode: string;
  detail: string;
  accountId: string;
  featureCode: string;
  entitlementId: string | null;
  quotaLimit: number | null;
  currentUsage: number | null;
  remainingQuota: number | null;
  supportLevel: SupportLevel | null;
  slaResponseMinutes: number | null;
  evaluatedAt: string;
}

@Injectable()
export class EntitlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customerService: CustomerService,
    private readonly auditService: AuditService,
    private readonly webhookService: WebhookService,
  ) {}

  async list(query: ListEntitlementsQueryDto) {
    const limit = query.limit ?? 20;
    const cursorId = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = await this.prisma.entitlement.findMany({
      where: {
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.featureCode ? { featureCode: query.featureCode } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const page = buildCursorPage(rows, limit);
    return {
      data: page.data.map((r) => this.toDto(r)),
      page: page.page,
    };
  }

  async getById(entitlementId: string) {
    const row = await this.prisma.entitlement.findUnique({
      where: { id: entitlementId },
    });
    if (!row) {
      throw Problems.notFound(
        `Entitlement '${entitlementId}' was not found.`,
        'ENTITLEMENT_NOT_FOUND',
      );
    }
    return this.toDto(row);
  }

  async create(dto: CreateEntitlementDto, actor: ActorContext) {
    await this.customerService.findByAccountIdOrThrow(dto.accountId);

    const effectiveFrom = new Date(dto.effectiveFrom);
    const effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : null;

    if (effectiveTo && effectiveTo <= effectiveFrom) {
      throw Problems.unprocessable(
        'effectiveTo must be strictly later than effectiveFrom.',
        'INVALID_ENTITLEMENT_WINDOW',
      );
    }

    if (dto.kind === 'METERED_QUOTA' && dto.quotaLimit === undefined) {
      throw Problems.unprocessable(
        'METERED_QUOTA entitlements require quotaLimit.',
        'MISSING_QUOTA_LIMIT',
      );
    }

    if (
      dto.kind === 'SUPPORT_PLAN' &&
      (!dto.supportLevel || !dto.maxCaseSeverity || !dto.slaResponseMinutes)
    ) {
      throw Problems.unprocessable(
        'SUPPORT_PLAN entitlements require supportLevel, maxCaseSeverity, and slaResponseMinutes.',
        'MISSING_SUPPORT_PLAN_FIELDS',
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.entitlement.create({
        data: {
          accountId: dto.accountId,
          contractRef: dto.contractRef ?? null,
          featureCode: dto.featureCode,
          kind: dto.kind,
          status: dto.status ?? 'ACTIVE',
          quotaLimit: dto.quotaLimit ?? null,
          quotaUnit: dto.quotaUnit ?? null,
          supportLevel: dto.supportLevel ?? null,
          maxCaseSeverity: dto.maxCaseSeverity ?? null,
          slaResponseMinutes: dto.slaResponseMinutes ?? null,
          effectiveFrom,
          effectiveTo,
        },
      });
      const out = this.toDto(row);
      await this.auditService.record(
        {
          actor,
          accountId: row.accountId,
          action: 'entitlement.created',
          entityType: 'Entitlement',
          entityId: row.id,
          metadata: { featureCode: row.featureCode, kind: row.kind, quotaLimit: row.quotaLimit },
        },
        tx,
      );
      await this.webhookService.emitEvent(
        {
          eventType: 'entitlement.created',
          accountId: row.accountId,
          data: out,
        },
        tx,
      );
      return out;
    });

    return created;
  }

  async update(
    entitlementId: string,
    dto: UpdateEntitlementDto,
    ifMatchHeader: string | undefined,
    actor: ActorContext,
  ) {
    const expectedVersion = parseIfMatchVersion(ifMatchHeader);
    if (
      dto.status === undefined &&
      dto.quotaLimit === undefined &&
      dto.supportLevel === undefined &&
      dto.maxCaseSeverity === undefined &&
      dto.slaResponseMinutes === undefined &&
      dto.effectiveTo === undefined
    ) {
      throw Problems.badRequest(
        'At least one updatable field must be provided.',
        'EMPTY_UPDATE_PAYLOAD',
      );
    }

    const current = await this.prisma.entitlement.findUnique({
      where: { id: entitlementId },
    });
    if (!current) {
      throw Problems.notFound(
        `Entitlement '${entitlementId}' was not found.`,
        'ENTITLEMENT_NOT_FOUND',
      );
    }
    assertExpectedVersion(expectedVersion, current.version);

    const nextEffectiveTo =
      dto.effectiveTo === undefined
        ? current.effectiveTo
        : dto.effectiveTo === null
          ? null
          : new Date(dto.effectiveTo);

    if (nextEffectiveTo && nextEffectiveTo <= current.effectiveFrom) {
      throw Problems.unprocessable(
        'effectiveTo must be strictly later than effectiveFrom.',
        'INVALID_ENTITLEMENT_WINDOW',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.entitlement.updateMany({
        where: { id: entitlementId, version: expectedVersion },
        data: {
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.quotaLimit !== undefined ? { quotaLimit: dto.quotaLimit } : {}),
          ...(dto.supportLevel !== undefined ? { supportLevel: dto.supportLevel } : {}),
          ...(dto.maxCaseSeverity !== undefined
            ? { maxCaseSeverity: dto.maxCaseSeverity }
            : {}),
          ...(dto.slaResponseMinutes !== undefined
            ? { slaResponseMinutes: dto.slaResponseMinutes }
            : {}),
          ...(dto.effectiveTo !== undefined ? { effectiveTo: nextEffectiveTo } : {}),
          version: { increment: 1 },
        },
      });

      if (res.count === 0) {
        throw Problems.preconditionFailed(
          `Concurrent modification detected for entitlement '${entitlementId}'.`,
          'ETAG_MISMATCH',
        );
      }

      const row = await tx.entitlement.findUniqueOrThrow({ where: { id: entitlementId } });
      const out = this.toDto(row);
      await this.auditService.record(
        {
          actor,
          accountId: row.accountId,
          action: 'entitlement.updated',
          entityType: 'Entitlement',
          entityId: row.id,
          metadata: { previousVersion: expectedVersion, newVersion: row.version, changes: dto },
        },
        tx,
      );
      await this.webhookService.emitEvent(
        {
          eventType: 'entitlement.updated',
          accountId: row.accountId,
          data: out,
        },
        tx,
      );
      return out;
    });

    return updated;
  }

  async evaluate(dto: EvaluateEntitlementDto): Promise<EntitlementDecision> {
    const evalTime = dto.at ? new Date(dto.at) : new Date();
    const customer = await this.customerService.findByAccountIdOrThrow(dto.accountId);

    if (customer.status === 'SUSPENDED' || customer.status === 'CHURNED') {
      return {
        allowed: false,
        reasonCode: `ACCOUNT_${customer.status}`,
        detail: `Account '${customer.accountId}' has status ${customer.status} and is not eligible for active entitlements.`,
        accountId: customer.accountId,
        featureCode: dto.featureCode,
        entitlementId: null,
        quotaLimit: null,
        currentUsage: null,
        remainingQuota: null,
        supportLevel: null,
        slaResponseMinutes: null,
        evaluatedAt: evalTime.toISOString(),
      };
    }

    const candidates = await this.prisma.entitlement.findMany({
      where: {
        accountId: dto.accountId,
        featureCode: dto.featureCode,
      },
      orderBy: [{ createdAt: 'desc' }],
    });

    if (candidates.length === 0) {
      return {
        allowed: false,
        reasonCode: 'NO_ENTITLEMENT',
        detail: `No '${dto.featureCode}' entitlement exists for account '${dto.accountId}'.`,
        accountId: dto.accountId,
        featureCode: dto.featureCode,
        entitlementId: null,
        quotaLimit: null,
        currentUsage: null,
        remainingQuota: null,
        supportLevel: null,
        slaResponseMinutes: null,
        evaluatedAt: evalTime.toISOString(),
      };
    }

    const active = candidates.find(
      (c) =>
        c.status === 'ACTIVE' &&
        c.effectiveFrom <= evalTime &&
        (c.effectiveTo === null || c.effectiveTo > evalTime),
    );

    if (!active) {
      const latest = candidates[0];
      return {
        allowed: false,
        reasonCode: latest.status === 'REVOKED' ? 'ENTITLEMENT_REVOKED' : 'ENTITLEMENT_EXPIRED',
        detail: `Entitlement '${latest.id}' for '${dto.featureCode}' is not active at ${evalTime.toISOString()}.`,
        accountId: dto.accountId,
        featureCode: dto.featureCode,
        entitlementId: latest.id,
        quotaLimit: latest.quotaLimit,
        currentUsage: null,
        remainingQuota: null,
        supportLevel: (latest.supportLevel as SupportLevel | null) ?? null,
        slaResponseMinutes: latest.slaResponseMinutes,
        evaluatedAt: evalTime.toISOString(),
      };
    }

    if (active.kind === 'METERED_QUOTA' && active.quotaLimit !== null) {
      const agg = await this.prisma.usageEvent.aggregate({
        where: { accountId: dto.accountId, metricCode: dto.featureCode },
        _sum: { quantity: true },
      });
      const currentUsage = agg._sum.quantity ?? 0;
      const requested = dto.requestedQuantity ?? 1;
      const projected = currentUsage + requested;
      const remainingQuota = Math.max(0, active.quotaLimit - currentUsage);

      if (projected > active.quotaLimit) {
        return {
          allowed: false,
          reasonCode: 'QUOTA_EXCEEDED',
          detail: `Requested quantity (${requested}) plus current usage (${currentUsage}) exceeds quota limit (${active.quotaLimit}) for '${dto.featureCode}'.`,
          accountId: dto.accountId,
          featureCode: dto.featureCode,
          entitlementId: active.id,
          quotaLimit: active.quotaLimit,
          currentUsage,
          remainingQuota,
          supportLevel: null,
          slaResponseMinutes: null,
          evaluatedAt: evalTime.toISOString(),
        };
      }

      return {
        allowed: true,
        reasonCode: 'ENTITLED',
        detail: `Account '${dto.accountId}' is within quota for '${dto.featureCode}'.`,
        accountId: dto.accountId,
        featureCode: dto.featureCode,
        entitlementId: active.id,
        quotaLimit: active.quotaLimit,
        currentUsage,
        remainingQuota,
        supportLevel: null,
        slaResponseMinutes: null,
        evaluatedAt: evalTime.toISOString(),
      };
    }

    if (active.kind === 'SUPPORT_PLAN') {
      const maxSeverity = (active.maxCaseSeverity as CaseSeverity | null) ?? 'P4';
      if (dto.requestedSeverity) {
        const reqRank = SEVERITY_RANK[dto.requestedSeverity];
        const maxRank = SEVERITY_RANK[maxSeverity];
        if (reqRank < maxRank) {
          return {
            allowed: false,
            reasonCode: 'SEVERITY_NOT_ENTITLED',
            detail: `Support plan '${active.supportLevel}' allows maximum severity ${maxSeverity}; requested ${dto.requestedSeverity}.`,
            accountId: dto.accountId,
            featureCode: dto.featureCode,
            entitlementId: active.id,
            quotaLimit: null,
            currentUsage: null,
            remainingQuota: null,
            supportLevel: (active.supportLevel as SupportLevel | null) ?? null,
            slaResponseMinutes: active.slaResponseMinutes,
            evaluatedAt: evalTime.toISOString(),
          };
        }
      }

      return {
        allowed: true,
        reasonCode: 'ENTITLED',
        detail: `Account '${dto.accountId}' is entitled to '${active.supportLevel}' support.`,
        accountId: dto.accountId,
        featureCode: dto.featureCode,
        entitlementId: active.id,
        quotaLimit: null,
        currentUsage: null,
        remainingQuota: null,
        supportLevel: (active.supportLevel as SupportLevel | null) ?? null,
        slaResponseMinutes: active.slaResponseMinutes,
        evaluatedAt: evalTime.toISOString(),
      };
    }

    return {
      allowed: true,
      reasonCode: 'ENTITLED',
      detail: `Account '${dto.accountId}' has active feature '${dto.featureCode}'.`,
      accountId: dto.accountId,
      featureCode: dto.featureCode,
      entitlementId: active.id,
      quotaLimit: null,
      currentUsage: null,
      remainingQuota: null,
      supportLevel: null,
      slaResponseMinutes: null,
      evaluatedAt: evalTime.toISOString(),
    };
  }

  toDto(row: Entitlement) {
    return {
      id: row.id,
      accountId: row.accountId,
      contractRef: row.contractRef,
      featureCode: row.featureCode,
      kind: row.kind as EntitlementKind,
      status: row.status as EntitlementStatus,
      quotaLimit: row.quotaLimit,
      quotaUnit: row.quotaUnit,
      supportLevel: (row.supportLevel as SupportLevel | null) ?? null,
      maxCaseSeverity: (row.maxCaseSeverity as CaseSeverity | null) ?? null,
      slaResponseMinutes: row.slaResponseMinutes,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

@Controller('v1/entitlements')
export class EntitlementController {
  constructor(private readonly entitlementService: EntitlementService) {}

  @Get()
  @RequireScopes('entitlements:read')
  listEntitlements(@Query() query: ListEntitlementsQueryDto) {
    return this.entitlementService.list(query);
  }

  @Post()
  @RequireScopes('entitlements:write')
  @Idempotent()
  async createEntitlement(
    @Body() dto: CreateEntitlementDto,
    @CurrentActor() actor: ActorContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const created = await this.entitlementService.create(dto, actor);
    reply.header('etag', formatEtag(created.version));
    return created;
  }

  @Post('evaluate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('entitlements:read')
  evaluateEntitlement(@Body() dto: EvaluateEntitlementDto) {
    return this.entitlementService.evaluate(dto);
  }

  @Get(':entitlementId')
  @RequireScopes('entitlements:read')
  async getEntitlement(
    @Param('entitlementId') entitlementId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const entitlement = await this.entitlementService.getById(entitlementId);
    reply.header('etag', formatEtag(entitlement.version));
    return entitlement;
  }

  @Patch(':entitlementId')
  @RequireScopes('entitlements:write')
  async updateEntitlement(
    @Param('entitlementId') entitlementId: string,
    @Body() dto: UpdateEntitlementDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentActor() actor: ActorContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const updated = await this.entitlementService.update(
      entitlementId,
      dto,
      ifMatch,
      actor,
    );
    reply.header('etag', formatEtag(updated.version));
    return updated;
  }
}

@Module({
  imports: [CustomerModule],
  controllers: [EntitlementController],
  providers: [EntitlementService],
  exports: [EntitlementService],
})
export class EntitlementModule {}

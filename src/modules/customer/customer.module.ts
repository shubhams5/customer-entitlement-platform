import {
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Logger,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Customer, Entitlement, SupportCase } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { FastifyReply } from 'fastify';
import { AppConfig } from '../../common/config/app-config';
import {
  ActorContext,
  CurrentActor,
  RequireScopes,
  hasScope,
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
import { Idempotent } from '../idempotency/idempotency.module';
import { WebhookService } from '../webhook/webhook.module';
import { buildUsageSummary } from '../usage/usage-summary';
import {
  assertCanWriteRestrictedFields,
  CustomerView,
  customerViewFor,
  PUBLIC_CUSTOMER_VIEW,
  redactRestrictedFields,
} from './customer-field-policy';

export const CUSTOMER_STATUSES = ['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CHURNED'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const CUSTOMER_TIERS = ['STARTER', 'BUSINESS', 'ENTERPRISE', 'Platinum'] as const;
export type CustomerTier = (typeof CUSTOMER_TIERS)[number];

const MAX_ARR = 2_000_000_000;

export class ListCustomersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(CUSTOMER_STATUSES)
  status?: CustomerStatus;

  @IsOptional()
  @IsIn(CUSTOMER_TIERS)
  tier?: CustomerTier;
}

export class CreateCustomerDto {
  @IsString()
  @Matches(/^(?:acct_[A-Za-z0-9_-]{6,64}|ACC-\d{3})$/, {
    message: 'accountId must match acct_<6..64 chars> or ACC-<3 digits>',
  })
  accountId: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @IsEmail()
  primaryEmail: string;

  @IsIn(CUSTOMER_TIERS)
  tier: CustomerTier;

  @IsOptional()
  @IsIn(CUSTOMER_STATUSES)
  status?: CustomerStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalCrmId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_ARR)
  annualRecurringRevenue?: number;
}

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsEmail()
  primaryEmail?: string;

  @IsOptional()
  @IsIn(CUSTOMER_TIERS)
  tier?: CustomerTier;

  @IsOptional()
  @IsIn(CUSTOMER_STATUSES)
  status?: CustomerStatus;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @ValidateIf((o: UpdateCustomerDto) => o.annualRecurringRevenue !== null && o.annualRecurringRevenue !== undefined)
  @IsInt()
  @Min(0)
  @Max(MAX_ARR)
  annualRecurringRevenue?: number | null;
}

export interface CustomerDto {
  accountId: string;
  name: string;
  primaryEmail: string;
  tier: CustomerTier;
  status: CustomerStatus;
  externalCrmId: string | null;
  region: string;
  annualRecurringRevenue?: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class CustomerService {
  private readonly logger = new Logger(CustomerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly webhookService: WebhookService,
    private readonly config: AppConfig,
  ) {}

  async list(query: ListCustomersQueryDto, actor: ActorContext) {
    const limit = query.limit ?? 20;
    const cursorId = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = await this.prisma.customer.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.tier ? { tier: query.tier } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const view = customerViewFor(actor);
    const page = buildCursorPage(rows, limit);
    return {
      data: page.data.map((r) => this.toDto(r, view)),
      page: page.page,
    };
  }

  async findByAccountIdOrThrow(accountId: string): Promise<Customer> {
    const customer = await this.prisma.customer.findUnique({
      where: { accountId },
    });
    if (!customer) {
      throw Problems.notFound(
        `Customer account '${accountId}' was not found.`,
        'CUSTOMER_NOT_FOUND',
      );
    }
    return customer;
  }

  async getByAccountId(accountId: string, actor: ActorContext) {
    const row = await this.findByAccountIdOrThrow(accountId);
    const now = new Date();
    const [entitlements, usage, cases] = await Promise.all([
      this.loadOverviewSection('entitlements', accountId, async () => {
        const rows = await this.prisma.entitlement.findMany({
          where: { accountId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        return rows.map((item) => this.toEntitlementDto(item));
      }, hasScope(actor, 'entitlements:read')),
      this.loadOverviewSection('usage', accountId, async () => {
        const [grouped, quotas] = await Promise.all([
          this.prisma.usageEvent.groupBy({
            by: ['metricCode'],
            where: { accountId },
            _sum: { quantity: true },
            _count: { _all: true },
          }),
          this.prisma.entitlement.findMany({
            where: {
              accountId,
              kind: 'METERED_QUOTA',
              status: 'ACTIVE',
              effectiveFrom: { lte: now },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            },
            select: { featureCode: true, quotaLimit: true },
          }),
        ]);
        return buildUsageSummary(accountId, grouped, quotas, now);
      }, hasScope(actor, 'usage:read')),
      this.loadOverviewSection('cases', accountId, async () => {
        const rows = await this.prisma.supportCase.findMany({
          where: { accountId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        return rows.map((item) => this.toCaseDto(item));
      }, hasScope(actor, 'cases:read')),
    ]);

    return {
      ...this.toDto(row, customerViewFor(actor)),
      entitlements: entitlements.data,
      usage: usage.data,
      cases: cases.data,
      generatedAt: now.toISOString(),
      partialFailures: [
        ...(entitlements.failure ? [{ section: 'entitlements' as const, code: entitlements.failure }] : []),
        ...(usage.failure ? [{ section: 'usage' as const, code: usage.failure }] : []),
        ...(cases.failure ? [{ section: 'cases' as const, code: cases.failure }] : []),
      ],
    };
  }

  private async loadOverviewSection<T>(
    section: 'entitlements' | 'usage' | 'cases',
    accountId: string,
    load: () => Promise<T>,
    allowed: boolean,
  ): Promise<{ data: T | null; failure: 'SECTION_FORBIDDEN' | 'SECTION_UNAVAILABLE' | null }> {
    if (!allowed) {
      return { data: null, failure: 'SECTION_FORBIDDEN' };
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Customer overview ${section} section timed out.`)),
          this.config.overview.sectionTimeoutMs,
        );
      });
      return { data: await Promise.race([load(), timeout]), failure: null };
    } catch (err) {
      this.logger.warn({
        msg: 'customer.overview.section_failed',
        accountId,
        section,
        error: err instanceof Error ? err.message : String(err),
      });
      return { data: null, failure: 'SECTION_UNAVAILABLE' };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private toEntitlementDto(row: Entitlement) {
    return {
      id: row.id,
      accountId: row.accountId,
      contractRef: row.contractRef,
      featureCode: row.featureCode,
      kind: row.kind,
      status: row.status,
      quotaLimit: row.quotaLimit,
      quotaUnit: row.quotaUnit,
      supportLevel: row.supportLevel,
      maxCaseSeverity: row.maxCaseSeverity,
      slaResponseMinutes: row.slaResponseMinutes,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveTo: row.effectiveTo?.toISOString() ?? null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toCaseDto(row: SupportCase) {
    return {
      id: row.id,
      caseNumber: row.caseNumber,
      accountId: row.accountId,
      entitlementId: row.entitlementId,
      subject: row.subject,
      description: row.description,
      severity: row.severity,
      status: row.status,
      entitledSupportLevel: row.entitledSupportLevel,
      requesterEmail: row.requesterEmail,
      assigneeId: row.assigneeId,
      slaResponseDueAt: row.slaResponseDueAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      escalatedAt: row.escalatedAt?.toISOString() ?? null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async create(dto: CreateCustomerDto, actor: ActorContext): Promise<CustomerDto> {
    assertCanWriteRestrictedFields(actor, dto);

    const existing = await this.prisma.customer.findUnique({
      where: { accountId: dto.accountId },
    });
    if (existing) {
      throw Problems.conflict(
        `Customer with accountId '${dto.accountId}' already exists.`,
        'CUSTOMER_ALREADY_EXISTS',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.customer.create({
        data: {
          accountId: dto.accountId,
          name: dto.name,
          primaryEmail: dto.primaryEmail,
          tier: dto.tier,
          status: dto.status ?? 'ACTIVE',
          externalCrmId: dto.externalCrmId ?? null,
          region: dto.region ?? 'us-east',
          annualRecurringRevenue: dto.annualRecurringRevenue ?? null,
        },
      });
      await this.auditService.record(
        {
          actor,
          accountId: row.accountId,
          action: 'customer.created',
          entityType: 'Customer',
          entityId: row.accountId,
          metadata: {
            tier: row.tier,
            status: row.status,
            annualRecurringRevenueSet: row.annualRecurringRevenue !== null,
          },
        },
        tx,
      );
      await this.webhookService.emitEvent(
        {
          eventType: 'customer.created',
          accountId: row.accountId,
          data: { ...this.toDto(row, PUBLIC_CUSTOMER_VIEW) },
        },
        tx,
      );
      return this.toDto(row, customerViewFor(actor));
    });
  }

  async update(
    accountId: string,
    dto: UpdateCustomerDto,
    ifMatchHeader: string | undefined,
    actor: ActorContext,
  ): Promise<CustomerDto> {
    const expectedVersion = parseIfMatchVersion(ifMatchHeader);
    if (
      dto.name === undefined &&
      dto.primaryEmail === undefined &&
      dto.tier === undefined &&
      dto.status === undefined &&
      dto.region === undefined &&
      dto.annualRecurringRevenue === undefined
    ) {
      throw Problems.badRequest(
        'At least one updatable field must be provided.',
        'EMPTY_UPDATE_PAYLOAD',
      );
    }
    assertCanWriteRestrictedFields(actor, dto);

    const current = await this.findByAccountIdOrThrow(accountId);
    assertExpectedVersion(expectedVersion, current.version);

    return this.prisma.$transaction(async (tx) => {
      const res = await tx.customer.updateMany({
        where: { accountId, version: expectedVersion },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.primaryEmail !== undefined ? { primaryEmail: dto.primaryEmail } : {}),
          ...(dto.tier !== undefined ? { tier: dto.tier } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.region !== undefined ? { region: dto.region } : {}),
          ...(dto.annualRecurringRevenue !== undefined
            ? { annualRecurringRevenue: dto.annualRecurringRevenue }
            : {}),
          version: { increment: 1 },
        },
      });

      if (res.count === 0) {
        const latest = await tx.customer.findUnique({ where: { accountId } });
        throw Problems.preconditionFailed(
          `Concurrent modification detected for customer '${accountId}'. Current version is v${latest?.version ?? 'unknown'}.`,
          'ETAG_MISMATCH',
        );
      }

      const row = await tx.customer.findUniqueOrThrow({ where: { accountId } });
      await this.auditService.record(
        {
          actor,
          accountId,
          action: 'customer.updated',
          entityType: 'Customer',
          entityId: accountId,
          metadata: {
            previousVersion: expectedVersion,
            newVersion: row.version,
            changes: redactRestrictedFields({ ...dto }),
          },
        },
        tx,
      );
      await this.webhookService.emitEvent(
        {
          eventType: 'customer.updated',
          accountId,
          data: { ...this.toDto(row, PUBLIC_CUSTOMER_VIEW) },
        },
        tx,
      );
      return this.toDto(row, customerViewFor(actor));
    });
  }

  toDto(row: Customer, view: CustomerView): CustomerDto {
    return {
      accountId: row.accountId,
      name: row.name,
      primaryEmail: row.primaryEmail,
      tier: row.tier as CustomerTier,
      status: row.status as CustomerStatus,
      externalCrmId: row.externalCrmId,
      region: row.region,
      ...(view.includeArr ? { annualRecurringRevenue: row.annualRecurringRevenue } : {}),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

@Controller('v1/customers')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Get()
  @RequireScopes('customers:read')
  listCustomers(@Query() query: ListCustomersQueryDto, @CurrentActor() actor: ActorContext) {
    return this.customerService.list(query, actor);
  }

  @Post()
  @RequireScopes('customers:write')
  @Idempotent()
  async createCustomer(
    @Body() dto: CreateCustomerDto,
    @CurrentActor() actor: ActorContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const created = await this.customerService.create(dto, actor);
    reply.header('etag', formatEtag(created.version));
    return created;
  }

  @Get(':accountId')
  @RequireScopes('customers:read')
  async getCustomer(
    @Param('accountId') accountId: string,
    @CurrentActor() actor: ActorContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const customer = await this.customerService.getByAccountId(accountId, actor);
    reply.header('etag', formatEtag(customer.version));
    return customer;
  }

  @Patch(':accountId')
  @RequireScopes('customers:write')
  async updateCustomer(
    @Param('accountId') accountId: string,
    @Body() dto: UpdateCustomerDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentActor() actor: ActorContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const updated = await this.customerService.update(accountId, dto, ifMatch, actor);
    reply.header('etag', formatEtag(updated.version));
    return updated;
  }
}

@Module({
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}

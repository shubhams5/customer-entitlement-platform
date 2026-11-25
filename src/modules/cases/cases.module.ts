import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { CaseComment, Prisma, SupportCase } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { randomInt } from 'crypto';
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
  buildKeysetPage,
  PaginationQueryDto,
} from '../../common/pagination/cursor-pagination';
import { PrismaService } from '../../common/prisma/prisma.module';
import { AuditService } from '../audit/audit.module';
import { CustomerModule } from '../customer/customer.module';
import {
  CASE_SEVERITIES,
  CaseSeverity,
  EntitlementModule,
  EntitlementService,
  SupportLevel,
} from '../entitlement/entitlement.module';
import { IdempotencyKey, Idempotent } from '../idempotency/idempotency.module';
import { WebhookService } from '../webhook/webhook.module';
import {
  buildCaseSearchQuery,
  CaseSearchFilters,
  DEFAULT_CASE_SORT,
  parseCaseSort,
  sortValueOf,
} from './case-search';
import { assertEscalatable, assertTransition, statusSideEffects } from './case-workflow';

export const CASE_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_CUSTOMER',
  'ESCALATED',
  'RESOLVED',
  'CLOSED',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export class ListCasesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsIn(CASE_STATUSES)
  status?: CaseStatus;

  @IsOptional()
  @IsIn(CASE_SEVERITIES)
  severity?: CaseSeverity;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsDateString()
  createdAfter?: string;

  @IsOptional()
  @IsDateString()
  createdBefore?: string;

  @IsOptional()
  @IsString()
  sort?: string = DEFAULT_CASE_SORT;
}

export class CreateCaseDto {
  @IsString()
  accountId: string;

  @IsString()
  @MinLength(5)
  @MaxLength(240)
  subject: string;

  @IsString()
  @MinLength(10)
  @MaxLength(10000)
  description: string;

  @IsIn(CASE_SEVERITIES)
  severity: CaseSeverity;

  @IsEmail()
  requesterEmail: string;
}

export class UpdateCaseDto {
  @IsOptional()
  @IsIn(CASE_STATUSES)
  status?: CaseStatus;

  @IsOptional()
  @IsIn(CASE_SEVERITIES)
  severity?: CaseSeverity;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  assigneeId?: string | null;
}

export class CreateCaseCommentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  authorId: string;

  @IsIn(['CUSTOMER', 'AGENT', 'SYSTEM'])
  authorRole: 'CUSTOMER' | 'AGENT' | 'SYSTEM';

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;

  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

@Injectable()
export class CasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlementService: EntitlementService,
    private readonly auditService: AuditService,
    private readonly webhookService: WebhookService,
  ) {}

  async list(query: ListCasesQueryDto) {
    const limit = query.limit ?? 20;
    const sort = parseCaseSort(query.sort);
    const filters: CaseSearchFilters = {
      accountId: query.accountId,
      status: query.status,
      severity: query.severity,
      assigneeId: query.assigneeId,
      q: query.q,
      createdAfter: query.createdAfter,
      createdBefore: query.createdBefore,
    };
    const rows = await this.prisma.supportCase.findMany(
      buildCaseSearchQuery(filters, sort, limit, query.cursor),
    );

    const page = buildKeysetPage(rows, limit, sort.raw, (row) => sortValueOf(row, sort.field));
    return {
      data: page.data.map((r) => this.toCaseDto(r)),
      page: page.page,
    };
  }

  async getById(caseId: string) {
    const row = await this.prisma.supportCase.findUnique({
      where: { id: caseId },
      include: {
        comments: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!row) {
      throw Problems.notFound(`Support case '${caseId}' was not found.`, 'CASE_NOT_FOUND');
    }
    return {
      ...this.toCaseDto(row),
      comments: row.comments.map((c) => this.toCommentDto(c)),
    };
  }

  async create(dto: CreateCaseDto, actor: ActorContext) {
    const decision = await this.entitlementService.evaluate({
      accountId: dto.accountId,
      featureCode: 'SUPPORT_PORTAL',
      requestedSeverity: dto.severity,
    });

    if (!decision.allowed) {
      throw Problems.unprocessable(decision.detail, decision.reasonCode);
    }

    const now = new Date();
    const slaMinutes = decision.slaResponseMinutes ?? 240;
    const slaResponseDueAt = new Date(now.getTime() + slaMinutes * 60 * 1000);
    const entitledSupportLevel: SupportLevel = decision.supportLevel ?? 'STANDARD';

    const created = await this.prisma.$transaction(async (tx) => {
      const count = await tx.supportCase.count();
      const suffix = String(100001 + count + randomInt(1, 9)).slice(-6);
      const caseNumber = `CASE-${suffix}-${randomInt(10, 99)}`;

      const row = await tx.supportCase.create({
        data: {
          caseNumber,
          accountId: dto.accountId,
          entitlementId: decision.entitlementId,
          subject: dto.subject,
          description: dto.description,
          severity: dto.severity,
          status: 'OPEN',
          entitledSupportLevel,
          requesterEmail: dto.requesterEmail,
          slaResponseDueAt,
        },
      });

      const out = this.toCaseDto(row);
      await this.auditService.record(
        {
          actor,
          accountId: row.accountId,
          action: 'case.created',
          entityType: 'SupportCase',
          entityId: row.id,
          metadata: {
            caseNumber: row.caseNumber,
            severity: row.severity,
            entitledSupportLevel: row.entitledSupportLevel,
            slaResponseDueAt: out.slaResponseDueAt,
          },
        },
        tx,
      );
      await this.webhookService.emitEvent(
        {
          eventType: 'case.created',
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
    caseId: string,
    dto: UpdateCaseDto,
    ifMatchHeader: string | undefined,
    actor: ActorContext,
  ) {
    const expectedVersion = parseIfMatchVersion(ifMatchHeader);
    if (
      dto.status === undefined &&
      dto.severity === undefined &&
      dto.assigneeId === undefined
    ) {
      throw Problems.badRequest(
        'At least one updatable field must be provided.',
        'EMPTY_UPDATE_PAYLOAD',
      );
    }

    const current = await this.prisma.supportCase.findUnique({
      where: { id: caseId },
    });
    if (!current) {
      throw Problems.notFound(`Support case '${caseId}' was not found.`, 'CASE_NOT_FOUND');
    }

    assertExpectedVersion(expectedVersion, current.version);

    if (dto.status !== undefined) {
      if (dto.status === 'ESCALATED') {
        assertEscalatable(caseId, current.status as CaseStatus);
      } else {
        assertTransition(caseId, current.status as CaseStatus, dto.status);
      }
    }

    if (dto.severity && dto.severity !== current.severity) {
      const decision = await this.entitlementService.evaluate({
        accountId: current.accountId,
        featureCode: 'SUPPORT_PORTAL',
        requestedSeverity: dto.severity,
      });
      if (!decision.allowed) {
        throw Problems.unprocessable(decision.detail, decision.reasonCode);
      }
    }

    const sideEffects = dto.status
      ? statusSideEffects(
          {
            status: current.status as CaseStatus,
            resolvedAt: current.resolvedAt,
            escalatedAt: current.escalatedAt,
          },
          dto.status,
          new Date(),
        )
      : {
          resolvedAt: current.resolvedAt,
          escalatedAt: current.escalatedAt,
          isEscalation: false,
        };

    return this.prisma.$transaction(async (tx) => {
      const res = await tx.supportCase.updateMany({
        where: { id: caseId, version: expectedVersion },
        data: {
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.severity !== undefined ? { severity: dto.severity } : {}),
          ...(dto.assigneeId !== undefined ? { assigneeId: dto.assigneeId } : {}),
          resolvedAt: sideEffects.resolvedAt,
          escalatedAt: sideEffects.escalatedAt,
          version: { increment: 1 },
        },
      });

      if (res.count === 0) {
        throw Problems.preconditionFailed(
          `Concurrent modification detected for support case '${caseId}'.`,
          'ETAG_MISMATCH',
        );
      }

      const row = await tx.supportCase.findUniqueOrThrow({ where: { id: caseId } });
      const out = this.toCaseDto(row);
      await this.auditService.record(
        {
          actor,
          accountId: row.accountId,
          action: sideEffects.isEscalation ? 'case.escalated' : 'case.updated',
          entityType: 'SupportCase',
          entityId: row.id,
          metadata: {
            previousVersion: expectedVersion,
            newVersion: row.version,
            changes: dto,
          },
        },
        tx,
      );

      await this.webhookService.emitEvent(
        {
          eventType: sideEffects.isEscalation ? 'case.escalated' : 'case.updated',
          accountId: row.accountId,
          data: out,
        },
        tx,
      );

      return out;
    });
  }

  async addComment(
    caseId: string,
    dto: CreateCaseCommentDto,
    actor: ActorContext,
    idempotencyKey?: string,
  ) {
    const supportCase = await this.prisma.supportCase.findUnique({
      where: { id: caseId },
    });
    if (!supportCase) {
      throw Problems.notFound(`Support case '${caseId}' was not found.`, 'CASE_NOT_FOUND');
    }

    const commentWhere = idempotencyKey
      ? { caseId_idempotencyKey: { caseId, idempotencyKey } }
      : undefined;
    const existing = commentWhere
      ? await this.prisma.caseComment.findUnique({ where: commentWhere })
      : null;
    if (existing) {
      return this.replayComment(existing, dto);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const comment = await tx.caseComment.create({
          data: {
            caseId,
            authorId: dto.authorId,
            authorRole: dto.authorRole,
            body: dto.body,
            isInternal: dto.isInternal ?? false,
            idempotencyKey: idempotencyKey ?? null,
          },
        });
        await this.auditService.record(
          {
            actor,
            accountId: supportCase.accountId,
            action: 'case.comment.added',
            entityType: 'CaseComment',
            entityId: comment.id,
            metadata: { caseId, authorRole: dto.authorRole, isInternal: comment.isInternal },
          },
          tx,
        );
        return this.toCommentDto(comment);
      });
    } catch (err) {
      if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const duplicate = await this.prisma.caseComment.findUnique({
          where: { caseId_idempotencyKey: { caseId, idempotencyKey } },
        });
        if (duplicate) {
          return this.replayComment(duplicate, dto);
        }
      }
      throw err;
    }
  }

  private replayComment(row: CaseComment, dto: CreateCaseCommentDto) {
    if (
      row.authorId !== dto.authorId ||
      row.authorRole !== dto.authorRole ||
      row.body !== dto.body ||
      row.isInternal !== (dto.isInternal ?? false)
    ) {
      throw Problems.conflict(
        'The Idempotency-Key was already used with a different comment payload.',
        'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
      );
    }
    return this.toCommentDto(row);
  }

  toCaseDto(row: SupportCase) {
    return {
      id: row.id,
      caseNumber: row.caseNumber,
      accountId: row.accountId,
      entitlementId: row.entitlementId,
      subject: row.subject,
      description: row.description,
      severity: row.severity as CaseSeverity,
      status: row.status as CaseStatus,
      entitledSupportLevel: row.entitledSupportLevel as SupportLevel,
      requesterEmail: row.requesterEmail,
      assigneeId: row.assigneeId,
      slaResponseDueAt: row.slaResponseDueAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      escalatedAt: row.escalatedAt ? row.escalatedAt.toISOString() : null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  toCommentDto(row: CaseComment) {
    return {
      id: row.id,
      caseId: row.caseId,
      authorId: row.authorId,
      authorRole: row.authorRole as 'CUSTOMER' | 'AGENT' | 'SYSTEM',
      body: row.body,
      isInternal: row.isInternal,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

@Controller('v1/cases')
export class CasesController {
  constructor(private readonly casesService: CasesService) {}

  @Get()
  @RequireScopes('cases:read')
  listCases(@Query() query: ListCasesQueryDto) {
    return this.casesService.list(query);
  }

  @Post()
  @RequireScopes('cases:write')
  @Idempotent()
  async createCase(
    @Body() dto: CreateCaseDto,
    @CurrentActor() actor: ActorContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const created = await this.casesService.create(dto, actor);
    reply.header('etag', formatEtag(created.version));
    return created;
  }

  @Get(':caseId')
  @RequireScopes('cases:read')
  async getCase(
    @Param('caseId') caseId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const detail = await this.casesService.getById(caseId);
    reply.header('etag', formatEtag(detail.version));
    return detail;
  }

  @Patch(':caseId')
  @RequireScopes('cases:write')
  async updateCase(
    @Param('caseId') caseId: string,
    @Body() dto: UpdateCaseDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentActor() actor: ActorContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const updated = await this.casesService.update(caseId, dto, ifMatch, actor);
    reply.header('etag', formatEtag(updated.version));
    return updated;
  }

  @Post(':caseId/escalate')
  @HttpCode(200)
  @RequireScopes('cases:write')
  @Idempotent()
  async escalateCase(
    @Param('caseId') caseId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentActor() actor: ActorContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const updated = await this.casesService.update(
      caseId,
      { status: 'ESCALATED' },
      ifMatch,
      actor,
    );
    reply.header('etag', formatEtag(updated.version));
    return updated;
  }

  @Post(':caseId/comments')
  @RequireScopes('cases:write')
  @Idempotent()
  addComment(
    @Param('caseId') caseId: string,
    @Body() dto: CreateCaseCommentDto,
    @CurrentActor() actor: ActorContext,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ) {
    return this.casesService.addComment(caseId, dto, actor, idempotencyKey);
  }
}

@Module({
  imports: [CustomerModule, EntitlementModule],
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}

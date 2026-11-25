import { Controller, Get, Global, Injectable, Module, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AuditEvent as PrismaAuditEvent, Prisma } from '@prisma/client';
import { ActorContext, RequireScopes } from '../../common/auth/auth.decorators';
import {
  buildCursorPage,
  decodeCursor,
  PaginatedResult,
  PaginationQueryDto,
} from '../../common/pagination/cursor-pagination';
import { PrismaService } from '../../common/prisma/prisma.module';

export class ListAuditEventsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  action?: string;
}

export interface AuditEventDto {
  id: string;
  accountId: string | null;
  actorId: string;
  actorScopes: string;
  action: string;
  entityType: string;
  entityId: string;
  traceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RecordAuditParams {
  actor: ActorContext;
  accountId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    params: RecordAuditParams,
    tx?: Prisma.TransactionClient,
  ): Promise<AuditEventDto> {
    const client = tx ?? this.prisma;
    const created = await client.auditEvent.create({
      data: {
        accountId: params.accountId ?? null,
        actorId: params.actor.actorId,
        actorScopes: params.actor.scopes.join(' '),
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        traceId: params.actor.traceId ?? null,
        metadataJson: JSON.stringify(params.metadata ?? {}),
      },
    });
    return this.toDto(created);
  }

  async list(query: ListAuditEventsQueryDto): Promise<PaginatedResult<AuditEventDto>> {
    const limit = query.limit ?? 20;
    const cursorId = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = await this.prisma.auditEvent.findMany({
      where: {
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.action ? { action: query.action } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const page = buildCursorPage(rows, limit);
    return {
      data: page.data.map((r) => this.toDto(r)),
      page: page.page,
    };
  }

  private toDto(row: PrismaAuditEvent): AuditEventDto {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    return {
      id: row.id,
      accountId: row.accountId,
      actorId: row.actorId,
      actorScopes: row.actorScopes,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      traceId: row.traceId,
      metadata,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

@Controller('v1/audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('events')
  @RequireScopes('audit:read')
  listEvents(@Query() query: ListAuditEventsQueryDto) {
    return this.auditService.list(query);
  }
}

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

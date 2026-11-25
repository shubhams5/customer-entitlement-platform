import { Prisma, SupportCase } from '@prisma/client';
import { Problems } from '../../common/errors/problem-details.exception';
import {
  decodeKeysetCursor,
  keysetAfter,
  SortDirection,
} from '../../common/pagination/cursor-pagination';

export const CASE_SORT_FIELDS = ['createdAt', 'updatedAt', 'slaResponseDueAt', 'severity'] as const;
export type CaseSortField = (typeof CASE_SORT_FIELDS)[number];

export const CASE_SORT_OPTIONS = CASE_SORT_FIELDS.flatMap((f) => [f, `-${f}`]);
export const DEFAULT_CASE_SORT = '-createdAt';

const DATE_FIELDS: ReadonlySet<CaseSortField> = new Set(['createdAt', 'updatedAt', 'slaResponseDueAt']);

export interface CaseSort {
  raw: string;
  field: CaseSortField;
  direction: SortDirection;
}

export interface CaseSearchFilters {
  accountId?: string;
  status?: string;
  severity?: string;
  assigneeId?: string;
  q?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export function parseCaseSort(raw: string | undefined): CaseSort {
  const value = raw ?? DEFAULT_CASE_SORT;
  const direction: SortDirection = value.startsWith('-') ? 'desc' : 'asc';
  const field = value.replace(/^-/, '') as CaseSortField;
  if (!CASE_SORT_FIELDS.includes(field)) {
    throw Problems.badRequest(
      `Unsupported sort '${value}'. Allowed: ${CASE_SORT_OPTIONS.join(', ')}.`,
      'INVALID_SORT',
    );
  }
  return { raw: value, field, direction };
}

export function sortValueOf(row: SupportCase, field: CaseSortField): string {
  const v = row[field];
  return v instanceof Date ? v.toISOString() : String(v);
}

function cursorValue(field: CaseSortField, raw: string): Date | string {
  if (!DATE_FIELDS.has(field)) {
    return raw;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw Problems.badRequest('Query parameter "cursor" is not a valid pagination token.', 'INVALID_CURSOR');
  }
  return date;
}

export function buildCaseFilterWhere(filters: CaseSearchFilters): Prisma.SupportCaseWhereInput[] {
  const and: Prisma.SupportCaseWhereInput[] = [];
  if (filters.accountId) and.push({ accountId: filters.accountId });
  if (filters.status) and.push({ status: filters.status });
  if (filters.severity) and.push({ severity: filters.severity });
  if (filters.assigneeId) and.push({ assigneeId: filters.assigneeId });
  if (filters.createdAfter) and.push({ createdAt: { gte: new Date(filters.createdAfter) } });
  if (filters.createdBefore) and.push({ createdAt: { lt: new Date(filters.createdBefore) } });
  if (filters.q) {
    const q = filters.q.trim();
    and.push({
      OR: [
        { subject: { contains: q } },
        { description: { contains: q } },
        { caseNumber: { contains: q } },
      ],
    });
  }
  return and;
}

/** Full Prisma query arguments (filter + keyset + order) for one page. */
export function buildCaseSearchQuery(
  filters: CaseSearchFilters,
  sort: CaseSort,
  limit: number,
  cursor?: string,
): Prisma.SupportCaseFindManyArgs {
  if (filters.createdAfter && filters.createdBefore && new Date(filters.createdAfter) >= new Date(filters.createdBefore)) {
    throw Problems.badRequest('createdAfter must be earlier than createdBefore.', 'INVALID_DATE_RANGE');
  }

  const and = buildCaseFilterWhere(filters);
  if (cursor) {
    const decoded = decodeKeysetCursor(cursor, sort.raw);
    and.push(
      keysetAfter(sort.field, sort.direction, cursorValue(sort.field, decoded.value), decoded.id) as Prisma.SupportCaseWhereInput,
    );
  }

  return {
    where: and.length > 0 ? { AND: and } : {},
    orderBy: [{ [sort.field]: sort.direction }, { id: sort.direction }],
    take: limit + 1,
  };
}

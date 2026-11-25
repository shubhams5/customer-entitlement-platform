import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Problems } from '../errors/problem-details.exception';

export class PaginationQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export interface PageMeta {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface PaginatedResult<T> {
  data: T[];
  page: PageMeta;
}

interface CursorPayload {
  id: string;
}

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id } satisfies CursorPayload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<CursorPayload>;
    if (!parsed || typeof parsed.id !== 'string' || parsed.id.trim().length === 0) {
      throw new Error('Missing cursor id');
    }
    return parsed.id;
  } catch {
    throw Problems.badRequest(
      'Query parameter "cursor" is not a valid pagination token.',
      'INVALID_CURSOR',
    );
  }
}

export type SortDirection = 'asc' | 'desc';

/**
 * Keyset cursor for collections sortable by a non-unique column: encodes the
 * sort key of the last row plus its `id` as tie-breaker, and is bound to the
 * sort it was issued for so it cannot be replayed against another ordering.
 */
export interface KeysetCursor {
  sort: string;
  value: string;
  id: string;
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(
    JSON.stringify({ s: cursor.sort, v: cursor.value, id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeKeysetCursor(cursor: string, expectedSort: string): KeysetCursor {
  let parsed: { s?: unknown; v?: unknown; id?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    parsed = {};
  }
  if (
    !parsed ||
    typeof parsed.s !== 'string' ||
    typeof parsed.v !== 'string' ||
    typeof parsed.id !== 'string' ||
    parsed.id.length === 0
  ) {
    throw Problems.badRequest(
      'Query parameter "cursor" is not a valid pagination token.',
      'INVALID_CURSOR',
    );
  }
  if (parsed.s !== expectedSort) {
    throw Problems.badRequest(
      `Cursor was issued for sort '${parsed.s}' but the request uses sort '${expectedSort}'.`,
      'CURSOR_SORT_MISMATCH',
    );
  }
  return { sort: parsed.s, value: parsed.v, id: parsed.id };
}

/**
 * Builds the "rows strictly after the cursor" predicate for ORDER BY
 * (field dir, id dir): (field > v) OR (field = v AND id > lastId), with the
 * comparison flipped for descending order.
 */
export function keysetAfter<V>(
  field: string,
  direction: SortDirection,
  value: V,
  id: string,
): Record<string, unknown> {
  const op = direction === 'asc' ? 'gt' : 'lt';
  return {
    OR: [{ [field]: { [op]: value } }, { [field]: value, id: { [op]: id } }],
  };
}

export function buildKeysetPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  sort: string,
  sortValueOf: (row: T) => string,
): PaginatedResult<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    page: {
      nextCursor:
        hasMore && last ? encodeKeysetCursor({ sort, value: sortValueOf(last), id: last.id }) : null,
      hasMore,
      limit,
    },
  };
}

export function buildCursorPage<T extends { id: string }>(
  rows: T[],
  limit: number,
): PaginatedResult<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  return {
    data,
    page: {
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
      hasMore,
      limit,
    },
  };
}

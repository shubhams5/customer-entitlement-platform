import { ProblemException } from '../../common/errors/problem-details.exception';
import { encodeKeysetCursor } from '../../common/pagination/cursor-pagination';
import {
  buildCaseSearchQuery,
  DEFAULT_CASE_SORT,
  parseCaseSort,
} from './case-search';

describe('case search', () => {
  it('builds a filtered keyset query with deterministic ordering', () => {
    const sort = parseCaseSort('-createdAt');
    const cursor = encodeKeysetCursor({
      sort: sort.raw,
      value: '2026-01-02T03:04:05.000Z',
      id: 'case_123456',
    });

    const query = buildCaseSearchQuery(
      {
        accountId: 'acct_123456',
        status: 'OPEN',
        severity: 'P1',
        assigneeId: 'agent_1',
        q: 'gateway',
        createdAfter: '2026-01-01T00:00:00.000Z',
        createdBefore: '2026-02-01T00:00:00.000Z',
      },
      sort,
      10,
      cursor,
    );

    expect(query).toMatchObject({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 11,
      where: {
        AND: expect.arrayContaining([
          { accountId: 'acct_123456' },
          { status: 'OPEN' },
          { severity: 'P1' },
          { assigneeId: 'agent_1' },
          { createdAt: { gte: new Date('2026-01-01T00:00:00.000Z') } },
          { createdAt: { lt: new Date('2026-02-01T00:00:00.000Z') } },
          expect.objectContaining({ OR: expect.any(Array) }),
        ]),
      },
    });
  });

  it('uses the default sort and rejects invalid sort fields and date ranges', () => {
    expect(parseCaseSort(undefined).raw).toBe(DEFAULT_CASE_SORT);
    expect(() => parseCaseSort('accountId')).toThrow(ProblemException);
    expect(() =>
      buildCaseSearchQuery(
        { createdAfter: '2026-02-01T00:00:00.000Z', createdBefore: '2026-01-01T00:00:00.000Z' },
        parseCaseSort(undefined),
        20,
      ),
    ).toThrow(ProblemException);
  });
});

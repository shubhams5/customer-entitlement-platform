import { assignmentSearchFilters, evaluateAssignmentMatches } from './assignment-evaluation';

const AS_OF = new Date('2026-11-25T00:00:00.000Z');
const assignmentCase = {
  id: 'case_assignment_acc007_p1',
  accountId: 'ACC-007',
  status: 'OPEN',
  severity: 'P1',
  createdAt: '2026-10-24T08:12:00.000Z',
};
const assignmentCustomer = {
  accountId: 'ACC-007',
  tier: 'Platinum',
  entitlementRenewals: [{ featureCode: 'SUPPORT_PORTAL', renewalDate: '2027-01-15T00:00:00.000Z' }],
  partialSections: [],
};

describe('assignment demo evaluation', () => {
  it('builds the strict 48-hour API filter and returns the fixture-derived match', () => {
    expect(assignmentSearchFilters(AS_OF)).toEqual({
      status: 'OPEN',
      severity: 'P1',
      createdBefore: '2026-11-23T00:00:00.000Z',
      sort: '-createdAt',
      limit: 25,
    });
    expect(evaluateAssignmentMatches([assignmentCase], [assignmentCustomer], AS_OF)).toEqual([{
      accountId: 'ACC-007',
      caseId: 'case_assignment_acc007_p1',
      caseAge: '31d 15h 48m',
      ageHours: 759.8,
      renewalDate: '2027-01-15',
    }]);
  });

  it('excludes cases at exactly 48 hours and renewals beyond the inclusive 90-day window', () => {
    const atCutoff = { ...assignmentCase, createdAt: '2026-11-23T00:00:00.000Z' };
    const afterRenewalWindow = {
      ...assignmentCustomer,
      entitlementRenewals: [{ featureCode: 'SUPPORT_PORTAL', renewalDate: '2027-02-24T00:00:00.000Z' }],
    };
    expect(evaluateAssignmentMatches([atCutoff], [assignmentCustomer], AS_OF)).toEqual([]);
    expect(evaluateAssignmentMatches([assignmentCase], [afterRenewalWindow], AS_OF)).toEqual([]);
  });
});

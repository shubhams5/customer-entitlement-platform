import { Problems } from '../../common/errors/problem-details.exception';

export const CASE_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_CUSTOMER',
  'ESCALATED',
  'RESOLVED',
  'CLOSED',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Allowed status transitions; staying in the same status is always allowed. */
export const CASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  OPEN: ['IN_PROGRESS', 'WAITING_CUSTOMER', 'ESCALATED', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_CUSTOMER', 'ESCALATED', 'RESOLVED', 'CLOSED'],
  WAITING_CUSTOMER: ['IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED'],
  ESCALATED: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return from === to || CASE_TRANSITIONS[from].includes(to);
}

export function assertTransition(caseId: string, from: CaseStatus, to: CaseStatus): void {
  if (!canTransition(from, to)) {
    throw Problems.unprocessable(
      from === 'CLOSED'
        ? `Support case '${caseId}' is CLOSED and cannot be reopened.`
        : `Support case '${caseId}' cannot transition from ${from} to ${to}.`,
      'INVALID_CASE_TRANSITION',
    );
  }
}

export function assertEscalatable(caseId: string, from: CaseStatus): void {
  if (from === 'ESCALATED') {
    throw Problems.unprocessable(`Support case '${caseId}' is already ESCALATED.`, 'CASE_ALREADY_ESCALATED');
  }
  assertTransition(caseId, from, 'ESCALATED');
}

export interface StatusSideEffects {
  resolvedAt: Date | null;
  escalatedAt: Date | null;
  isEscalation: boolean;
}

/**
 * Timestamps implied by a status change: entering RESOLVED stamps
 * `resolvedAt`, re-opening clears it; entering ESCALATED stamps `escalatedAt`.
 */
export function statusSideEffects(
  current: { status: CaseStatus; resolvedAt: Date | null; escalatedAt: Date | null },
  next: CaseStatus,
  now: Date,
): StatusSideEffects {
  const isEscalation = next === 'ESCALATED' && current.status !== 'ESCALATED';
  let resolvedAt = current.resolvedAt;
  if (next === 'RESOLVED' && current.resolvedAt === null) {
    resolvedAt = now;
  } else if (next !== 'RESOLVED' && next !== 'CLOSED') {
    resolvedAt = null;
  }
  return {
    resolvedAt,
    escalatedAt: isEscalation ? now : current.escalatedAt,
    isEscalation,
  };
}

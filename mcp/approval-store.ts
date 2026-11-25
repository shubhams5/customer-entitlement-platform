import { createHash, randomBytes } from 'node:crypto';
import type { DelegatedIdentity } from './identity';

const APPROVAL_TTL_MS = 60_000;

interface ApprovalGrant {
  actorId: string;
  fingerprint: string;
  caseId: string;
  expectedVersion: number;
  expiresAt: number;
}

export class ApprovalStore {
  private readonly grants = new Map<string, ApprovalGrant>();

  issue(identity: DelegatedIdentity, caseId: string, expectedVersion: number, now = Date.now()) {
    this.removeExpired(now);
    const token = randomBytes(32).toString('base64url');
    this.grants.set(hashToken(token), {
      actorId: identity.actorId,
      fingerprint: identity.fingerprint,
      caseId,
      expectedVersion,
      expiresAt: now + APPROVAL_TTL_MS,
    });
    return { token, expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString() };
  }

  consume(
    token: string,
    identity: DelegatedIdentity,
    caseId: string,
    expectedVersion: number,
    now = Date.now(),
  ): void {
    this.removeExpired(now);
    const key = hashToken(token);
    const grant = this.grants.get(key);
    if (!grant || grant.expiresAt <= now) {
      this.grants.delete(key);
      throw new Error('Approval token is invalid or expired.');
    }
    if (
      grant.actorId !== identity.actorId ||
      grant.fingerprint !== identity.fingerprint ||
      grant.caseId !== caseId ||
      grant.expectedVersion !== expectedVersion
    ) {
      throw new Error('Approval token does not match this user and escalation request.');
    }
    this.grants.delete(key);
  }

  private removeExpired(now: number): void {
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(key);
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

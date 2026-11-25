import { createHash } from 'node:crypto';

export interface DelegatedIdentity {
  accessToken: string;
  actorId: string;
  scopes: ReadonlySet<string>;
  fingerprint: string;
}

export function delegatedIdentityFromToken(accessToken: string): DelegatedIdentity {
  if (!accessToken || accessToken.length > 16_384) {
    throw new Error('NEST_API_TOKEN must be a non-empty bearer JWT.');
  }

  const segments = accessToken.split('.');
  if (segments.length !== 3) {
    throw new Error('NEST_API_TOKEN must be a bearer JWT.');
  }

  let claims: { sub?: unknown; scope?: unknown };
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('NEST_API_TOKEN has an invalid claims payload.');
  }

  if (
    typeof claims.sub !== 'string' ||
    claims.sub.length < 2 ||
    claims.sub.length > 128 ||
    typeof claims.scope !== 'string'
  ) {
    throw new Error('NEST_API_TOKEN is missing a valid subject or scope claim.');
  }

  return {
    accessToken,
    actorId: claims.sub,
    scopes: new Set(claims.scope.split(/\s+/).filter(Boolean)),
    fingerprint: createHash('sha256').update(accessToken).digest('hex').slice(0, 16),
  };
}

export function requireDelegatedScope(identity: DelegatedIdentity, scope: string): void {
  if (!identity.scopes.has(scope)) {
    throw new Error(`Missing required scope: ${scope}.`);
  }
}

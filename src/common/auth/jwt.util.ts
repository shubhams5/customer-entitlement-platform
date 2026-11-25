import { createHmac, timingSafeEqual } from 'crypto';
import { Problems } from '../errors/problem-details.exception';

export const ALL_OAUTH_SCOPES = [
  'customers:read',
  'customers:write',
  'customers:arr:read',
  'customers:arr:write',
  'entitlements:read',
  'entitlements:write',
  'usage:read',
  'usage:write',
  'cases:read',
  'cases:write',
  'integrations:write',
  'audit:read',
  'webhooks:read',
  'webhooks:write',
] as const;

export type OAuthScope = (typeof ALL_OAUTH_SCOPES)[number];

export interface JwtClaims {
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  scope: string;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function getJwtConfig() {
  return {
    secret:
      process.env.OAUTH_JWT_SECRET ??
      'local-dev-hs256-signing-secret-change-in-prod-9f86d081',
    issuer: process.env.OAUTH_ISSUER ?? 'https://auth.platform.local',
    audience: process.env.OAUTH_AUDIENCE ?? 'https://api.platform.local',
  };
}

export function signHs256Jwt(
  params: { sub: string; scopes: string[]; expiresInSeconds?: number },
  overrideSecret?: string,
): { token: string; expiresIn: number; scope: string } {
  const cfg = getJwtConfig();
  const secret = overrideSecret ?? cfg.secret;
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = params.expiresInSeconds ?? 3600;
  const scope = Array.from(new Set(params.scopes)).join(' ');

  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims: JwtClaims = {
    sub: params.sub,
    iss: cfg.issuer,
    aud: cfg.audience,
    iat: now,
    exp: now + expiresIn,
    scope,
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');

  return {
    token: `${signingInput}.${signature}`,
    expiresIn,
    scope,
  };
}

export function verifyHs256Jwt(token: string): JwtClaims {
  const cfg = getJwtConfig();
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw Problems.unauthorized('Malformed Bearer JWT.', 'MALFORMED_TOKEN');
  }

  const [encodedHeader, encodedPayload, encodedSig] = parts;
  let header: { alg?: string; typ?: string };
  let claims: JwtClaims;

  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as {
      alg?: string;
      typ?: string;
    };
    claims = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as JwtClaims;
  } catch {
    throw Problems.unauthorized('Bearer JWT could not be decoded.', 'MALFORMED_TOKEN');
  }

  if (header.alg !== 'HS256') {
    throw Problems.unauthorized('Unsupported JWT signing algorithm.', 'INVALID_TOKEN_ALG');
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = createHmac('sha256', cfg.secret).update(signingInput).digest();
  const providedSig = base64UrlDecode(encodedSig);

  if (
    expectedSig.length !== providedSig.length ||
    !timingSafeEqual(expectedSig, providedSig)
  ) {
    throw Problems.unauthorized('Invalid Bearer token signature.', 'INVALID_TOKEN_SIGNATURE');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw Problems.unauthorized('Bearer token has expired.', 'TOKEN_EXPIRED');
  }

  if (claims.iss !== cfg.issuer || claims.aud !== cfg.audience) {
    throw Problems.unauthorized(
      'Bearer token issuer or audience mismatch.',
      'INVALID_TOKEN_CLAIMS',
    );
  }

  if (!claims.sub || typeof claims.scope !== 'string') {
    throw Problems.unauthorized('Bearer token missing subject or scope.', 'INVALID_TOKEN_CLAIMS');
  }

  return claims;
}

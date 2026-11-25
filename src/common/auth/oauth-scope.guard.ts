import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Problems } from '../errors/problem-details.exception';
import { resolveCorrelationId } from '../logging/request-context';
import { CorrelatedRequest } from '../logging/request-context.interceptor';
import { IS_PUBLIC_KEY, REQUIRED_SCOPES_KEY } from './auth.decorators';
import { OAuthScope, verifyHs256Jwt } from './jwt.util';

@Injectable()
export class OAuthScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<CorrelatedRequest>();

    const traceId = req.correlationId ?? resolveCorrelationId(req.headers);
    req.correlationId = traceId;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw Problems.unauthorized(
        'Missing or malformed Authorization: Bearer <token> header.',
        'MISSING_BEARER_TOKEN',
      );
    }

    const rawToken = authHeader.slice('Bearer '.length).trim();
    if (!rawToken) {
      throw Problems.unauthorized('Empty Bearer token.', 'MISSING_BEARER_TOKEN');
    }

    const claims = verifyHs256Jwt(rawToken);
    const grantedScopes = claims.scope
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    req.actor = {
      actorId: claims.sub,
      scopes: grantedScopes,
      traceId,
    };

    const requiredScopes =
      this.reflector.getAllAndOverride<OAuthScope[]>(REQUIRED_SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const missing = requiredScopes.filter((scope) => !grantedScopes.includes(scope));
    if (missing.length > 0) {
      throw Problems.forbidden(
        `Insufficient OAuth scope. Missing required scope(s): ${missing.join(', ')}.`,
        'INSUFFICIENT_SCOPE',
      );
    }

    return true;
  }
}

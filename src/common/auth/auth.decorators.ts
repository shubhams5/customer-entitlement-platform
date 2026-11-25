import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { OAuthScope } from './jwt.util';

export const IS_PUBLIC_KEY = 'isPublicRoute';
export const REQUIRED_SCOPES_KEY = 'requiredOAuthScopes';

export interface ActorContext {
  actorId: string;
  scopes: string[];
  traceId: string;
}

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const RequireScopes = (...scopes: OAuthScope[]) =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);

export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ActorContext => {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { actor?: ActorContext; correlationId?: string }>();
    return (
      req.actor ?? {
        actorId: 'system',
        scopes: [],
        traceId: req.correlationId ?? 'req_internal',
      }
    );
  },
);

export function hasScope(actor: ActorContext, scope: OAuthScope): boolean {
  return actor.scopes.includes(scope);
}

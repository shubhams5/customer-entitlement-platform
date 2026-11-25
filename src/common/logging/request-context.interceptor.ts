import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { ActorContext } from '../auth/auth.decorators';
import { generateCorrelationId, RequestContext } from './request-context';

export type CorrelatedRequest = FastifyRequest & {
  correlationId?: string;
  actor?: ActorContext;
};

/**
 * Runs the handler pipeline inside an AsyncLocalStorage scope so services,
 * adapters, and the logger can read the correlation ID without it being
 * threaded through every call signature.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<CorrelatedRequest>();
    const store = {
      correlationId: req.correlationId ?? generateCorrelationId(),
      actorId: req.actor?.actorId,
      method: req.method,
      path: req.url.split('?')[0],
    };

    return new Observable((subscriber) =>
      RequestContext.run(store, () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => subscription.unsubscribe();
      }),
    );
  }
}

import { HttpStatus, ValidationError, ValidationPipe } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Problems } from './common/errors/problem-details.exception';
import { ProblemDetailsFilter } from './common/errors/problem-details.filter';
import { JsonLogger } from './common/logging/json-logger';
import { resolveCorrelationId } from './common/logging/request-context';
import { CorrelatedRequest } from './common/logging/request-context.interceptor';

function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): Array<{ field: string; message: string }> {
  const out: Array<{ field: string; message: string }> = [];
  for (const err of errors) {
    const path = parentPath ? `${parentPath}.${err.property}` : err.property;
    if (err.constraints) {
      for (const message of Object.values(err.constraints)) {
        out.push({ field: path, message });
      }
    }
    if (err.children && err.children.length > 0) {
      out.push(...flattenValidationErrors(err.children, path));
    }
  }
  return out;
}

export function configureNestFastifyApp(
  app: NestFastifyApplication,
  logger: JsonLogger = new JsonLogger(),
): void {
  app.useLogger(logger);

  const fastify = app.getHttpAdapter().getInstance();
  const startTimes = new WeakMap<object, bigint>();

  fastify.addHook('onRequest', (req, reply, done) => {
    const correlated = req as CorrelatedRequest;
    correlated.correlationId = resolveCorrelationId(req.headers);
    startTimes.set(req, process.hrtime.bigint());
    reply.header('x-request-id', correlated.correlationId);
    done();
  });

  fastify.addHook('onResponse', (req, reply, done) => {
    const correlated = req as CorrelatedRequest;
    const started = startTimes.get(req);
    const durationMs =
      started !== undefined ? Number(process.hrtime.bigint() - started) / 1e6 : undefined;
    const entry = {
      msg: 'http.request.completed',
      correlationId: correlated.correlationId,
      actorId: correlated.actor?.actorId,
      method: req.method,
      route: req.routeOptions?.url ?? req.url.split('?')[0],
      statusCode: reply.statusCode,
      durationMs: durationMs !== undefined ? Math.round(durationMs * 100) / 100 : undefined,
    };
    if (reply.statusCode >= 500) {
      logger.error(entry, undefined, 'HttpAccess');
    } else if (reply.statusCode >= 400) {
      logger.warn(entry, 'HttpAccess');
    } else {
      logger.log(entry, 'HttpAccess');
    }
    done();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      errorHttpStatusCode: HttpStatus.BAD_REQUEST,
      exceptionFactory: (errors: ValidationError[]) => {
        const formatted = flattenValidationErrors(errors);
        return Problems.badRequest(
          'Request validation failed on one or more fields.',
          'VALIDATION_FAILED',
          formatted,
        );
      },
    }),
  );

  app.useGlobalFilters(new ProblemDetailsFilter());
}

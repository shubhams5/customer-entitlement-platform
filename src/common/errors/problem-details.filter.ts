import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { resolveCorrelationId } from '../logging/request-context';
import {
  FieldValidationError,
  ProblemDetailsPayload,
  ProblemException,
} from './problem-details.exception';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest & { correlationId?: string }>();

    const traceId = request.correlationId ?? resolveCorrelationId(request.headers);

    const instance = request.url;
    let payload: ProblemDetailsPayload;

    if (exception instanceof ProblemException) {
      payload = {
        ...exception.problem,
        instance,
        traceId,
      };
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const validationErrors = this.extractValidationErrors(raw);

      payload = {
        type: `https://api.platform.local/problems/${this.slugForStatus(status)}`,
        title: this.titleForStatus(status),
        status,
        detail:
          validationErrors && validationErrors.length > 0
            ? 'Request validation failed on one or more fields.'
            : this.extractDetail(raw, exception.message),
        instance,
        code: validationErrors ? 'VALIDATION_FAILED' : this.codeForStatus(status),
        traceId,
        ...(validationErrors ? { errors: validationErrors } : {}),
      };
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === 'P2002'
    ) {
      const target = Array.isArray(exception.meta?.target)
        ? (exception.meta?.target as string[]).join(', ')
        : 'unique field';
      payload = {
        type: 'https://api.platform.local/problems/conflict',
        title: 'Conflict',
        status: HttpStatus.CONFLICT,
        detail: `A resource with the same ${target} already exists.`,
        instance,
        code: 'UNIQUE_CONSTRAINT_VIOLATION',
        traceId,
      };
    } else {
      this.logger.error(
        {
          msg: 'http.request.unhandled_error',
          correlationId: traceId,
          method: request.method,
          path: instance,
          error: exception instanceof Error ? exception.message : String(exception),
        },
        exception instanceof Error ? exception.stack : undefined,
      );
      payload = {
        type: 'https://api.platform.local/problems/internal-error',
        title: 'Internal Server Error',
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        detail: 'An unexpected internal error occurred.',
        instance,
        code: 'INTERNAL_SERVER_ERROR',
        traceId,
      };
    }

    for (const [name, value] of Object.entries(
      exception instanceof ProblemException ? exception.headers : {},
    )) {
      reply.header(name, value);
    }

    reply
      .status(payload.status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .header('x-request-id', traceId)
      .header('x-trace-id', traceId)
      .send(payload);
  }

  private extractValidationErrors(raw: unknown): FieldValidationError[] | undefined {
    if (typeof raw === 'object' && raw !== null && 'validationErrors' in raw) {
      const errs = (raw as { validationErrors?: FieldValidationError[] }).validationErrors;
      if (Array.isArray(errs)) {
        return errs;
      }
    }
    if (typeof raw === 'object' && raw !== null && 'message' in raw) {
      const msg = (raw as { message?: unknown }).message;
      if (Array.isArray(msg)) {
        return msg.map((entry) => {
          const text = String(entry);
          const firstSpace = text.indexOf(' ');
          return {
            field: firstSpace > 0 ? text.slice(0, firstSpace) : 'body',
            message: text,
          };
        });
      }
    }
    return undefined;
  }

  private extractDetail(raw: unknown, fallback: string): string {
    if (typeof raw === 'string') {
      return raw;
    }
    if (typeof raw === 'object' && raw !== null && 'message' in raw) {
      const msg = (raw as { message?: unknown }).message;
      if (typeof msg === 'string') {
        return msg;
      }
    }
    return fallback;
  }

  private slugForStatus(status: number): string {
    switch (status) {
      case 400:
        return 'bad-request';
      case 401:
        return 'unauthorized';
      case 403:
        return 'forbidden';
      case 404:
        return 'not-found';
      case 409:
        return 'conflict';
      case 412:
        return 'precondition-failed';
      case 422:
        return 'unprocessable-entity';
      case 428:
        return 'precondition-required';
      case 503:
        return 'service-unavailable';
      default:
        return 'http-error';
    }
  }

  private titleForStatus(status: number): string {
    switch (status) {
      case 400:
        return 'Bad Request';
      case 401:
        return 'Unauthorized';
      case 403:
        return 'Forbidden';
      case 404:
        return 'Resource Not Found';
      case 409:
        return 'Conflict';
      case 412:
        return 'Precondition Failed';
      case 422:
        return 'Unprocessable Content';
      case 428:
        return 'Precondition Required';
      case 503:
        return 'Service Unavailable';
      default:
        return 'HTTP Error';
    }
  }

  private codeForStatus(status: number): string {
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'RESOURCE_NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 412:
        return 'ETAG_MISMATCH';
      case 422:
        return 'VALIDATION_FAILED';
      case 428:
        return 'IF_MATCH_REQUIRED';
      default:
        return `HTTP_${status}`;
    }
  }
}

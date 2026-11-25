import { HttpException, HttpStatus } from '@nestjs/common';

export interface FieldValidationError {
  field: string;
  message: string;
}

export interface ProblemDetailsPayload {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: string;
  traceId?: string;
  errors?: FieldValidationError[];
}

const PROBLEM_BASE_URI = 'https://api.platform.local/problems';

export class ProblemException extends HttpException {
  public readonly problem: ProblemDetailsPayload;
  public readonly headers: Record<string, string>;

  constructor(
    payload: Omit<ProblemDetailsPayload, 'type'> & { slug: string },
    headers: Record<string, string> = {},
  ) {
    const body: ProblemDetailsPayload = {
      type: `${PROBLEM_BASE_URI}/${payload.slug}`,
      title: payload.title,
      status: payload.status,
      detail: payload.detail,
      code: payload.code,
      ...(payload.instance ? { instance: payload.instance } : {}),
      ...(payload.errors ? { errors: payload.errors } : {}),
    };
    super(body, payload.status);
    this.problem = body;
    this.headers = headers;
  }
}

export const Problems = {
  badRequest: (detail: string, code = 'BAD_REQUEST', errors?: FieldValidationError[]) =>
    new ProblemException({
      slug: 'bad-request',
      title: 'Bad Request',
      status: HttpStatus.BAD_REQUEST,
      detail,
      code,
      errors,
    }),

  unauthorized: (detail: string, code = 'UNAUTHORIZED') =>
    new ProblemException({
      slug: 'unauthorized',
      title: 'Unauthorized',
      status: HttpStatus.UNAUTHORIZED,
      detail,
      code,
    }),

  forbidden: (detail: string, code = 'FORBIDDEN') =>
    new ProblemException({
      slug: 'forbidden',
      title: 'Forbidden',
      status: HttpStatus.FORBIDDEN,
      detail,
      code,
    }),

  notFound: (detail: string, code = 'RESOURCE_NOT_FOUND') =>
    new ProblemException({
      slug: 'not-found',
      title: 'Resource Not Found',
      status: HttpStatus.NOT_FOUND,
      detail,
      code,
    }),

  conflict: (detail: string, code = 'CONFLICT') =>
    new ProblemException({
      slug: 'conflict',
      title: 'Conflict',
      status: HttpStatus.CONFLICT,
      detail,
      code,
    }),

  preconditionFailed: (detail: string, code = 'ETAG_MISMATCH') =>
    new ProblemException({
      slug: 'precondition-failed',
      title: 'Precondition Failed',
      status: HttpStatus.PRECONDITION_FAILED,
      detail,
      code,
    }),

  preconditionRequired: (detail: string, code = 'IF_MATCH_REQUIRED') =>
    new ProblemException({
      slug: 'precondition-required',
      title: 'Precondition Required',
      status: HttpStatus.PRECONDITION_REQUIRED,
      detail,
      code,
    }),

  unprocessable: (detail: string, code = 'DOMAIN_RULE_VIOLATION', errors?: FieldValidationError[]) =>
    new ProblemException({
      slug: 'unprocessable-entity',
      title: 'Unprocessable Content',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      detail,
      code,
      errors,
    }),

  serviceUnavailable: (detail: string, code = 'UPSTREAM_UNAVAILABLE', retryAfterSeconds?: number) =>
    new ProblemException(
      {
        slug: 'service-unavailable',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail,
        code,
      },
      retryAfterSeconds !== undefined ? { 'retry-after': String(retryAfterSeconds) } : {},
    ),
};

export const MAX_API_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 3_000;

export class NestApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`NestJS API request failed: ${status} ${code}`);
    this.name = 'NestApiError';
  }
}

export class ApiTransportError extends Error {
  constructor(readonly code: 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'RESPONSE_TOO_LARGE') {
    super(`NestJS API transport error: ${code}`);
    this.name = 'ApiTransportError';
  }
}

export class NestApiClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(this.baseUrl.protocol) ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.search ||
      this.baseUrl.hash
    ) {
      throw new Error('NEST_API_BASE_URL must be an HTTP(S) URL without credentials or query parameters.');
    }
    if (!this.baseUrl.pathname.endsWith('/')) this.baseUrl.pathname += '/';
  }

  async getJson(path: string, correlationId: string): Promise<unknown> {
    return this.withSafeRetry(() => this.request(path, 'GET', undefined, correlationId));
  }

  async postIdempotentJson(
    path: string,
    body: unknown,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<unknown> {
    return this.withSafeRetry(() =>
      this.request(path, 'POST', body, correlationId, { 'Idempotency-Key': idempotencyKey }),
    );
  }

  patchJson(path: string, body: unknown, ifMatch: string, correlationId: string): Promise<unknown> {
    return this.request(path, 'PATCH', body, correlationId, { 'If-Match': ifMatch });
  }

  private async withSafeRetry<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!this.isRetryable(error)) throw error;
      return request();
    }
  }

  private isRetryable(error: unknown): boolean {
    return (
      error instanceof ApiTransportError &&
      (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR')
    ) || (
      error instanceof NestApiError &&
      [502, 503, 504].includes(error.status)
    );
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body: unknown,
    correlationId: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(path.replace(/^\/+/, ''), this.baseUrl);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          'X-Request-Id': correlationId,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new ApiTransportError(name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR');
    }

    let text: string;
    try {
      text = await readBoundedBody(response);
    } catch (error) {
      if (error instanceof ApiTransportError) throw error;
      throw new ApiTransportError('NETWORK_ERROR');
    }

    if (!response.ok) {
      let code = 'API_ERROR';
      try {
        const problem: unknown = JSON.parse(text);
        if (
          typeof problem === 'object' &&
          problem !== null &&
          'code' in problem &&
          typeof problem.code === 'string' &&
          /^[A-Z0-9_]{1,64}$/.test(problem.code)
        ) {
          code = problem.code;
        }
      } catch {
        // Keep upstream error details out of MCP responses and logs.
      }
      throw new NestApiError(response.status, code);
    }

    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new ApiTransportError('INVALID_RESPONSE');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiTransportError('INVALID_RESPONSE');
    }
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_API_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ApiTransportError('RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

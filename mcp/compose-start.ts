import { startMcpServer } from './server';

export async function acquireDelegatedToken(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  scopes: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher(new URL('/oauth/token', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: scopes,
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {
    throw new Error('Could not reach the NestJS OAuth token endpoint.');
  });

  if (!response.ok) {
    throw new Error(`NestJS OAuth token endpoint returned HTTP ${response.status}.`);
  }

  let tokenResponse: unknown;
  try {
    tokenResponse = await response.json();
  } catch {
    throw new Error('NestJS OAuth token endpoint returned invalid JSON.');
  }

  if (
    typeof tokenResponse !== 'object' ||
    tokenResponse === null ||
    !('access_token' in tokenResponse) ||
    typeof tokenResponse.access_token !== 'string' ||
    tokenResponse.access_token.length === 0 ||
    !('token_type' in tokenResponse) ||
    tokenResponse.token_type !== 'Bearer'
  ) {
    throw new Error('NestJS OAuth token endpoint returned an invalid bearer token response.');
  }

  return tokenResponse.access_token;
}

async function start(): Promise<void> {
  const baseUrl = process.env.NEST_API_BASE_URL;
  if (!baseUrl) throw new Error('NEST_API_BASE_URL is required.');

  process.env.NEST_API_TOKEN = await acquireDelegatedToken(
    baseUrl,
    process.env.MCP_OAUTH_CLIENT_ID ?? 'support-agent-client',
    process.env.MCP_OAUTH_CLIENT_SECRET ?? 'dev-secret-support-agent',
    process.env.MCP_OAUTH_SCOPES ?? 'customers:read entitlements:read usage:read cases:read cases:write',
  );
  await startMcpServer();
}

if (require.main === module) {
  start().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'MCP startup failed.'}\n`,
    );
    process.exitCode = 1;
  });
}

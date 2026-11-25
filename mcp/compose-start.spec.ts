import { acquireDelegatedToken } from './compose-start';

describe('MCP Compose OAuth startup', () => {
  it('requests a least-privilege delegated token without exposing credentials', async () => {
    const fetcher: typeof fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'signed-token', token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      acquireDelegatedToken(
        'http://api:3000',
        'support-agent-client',
        'dev-secret-support-agent',
        'cases:read cases:write',
        fetcher,
      ),
    ).resolves.toBe('signed-token');
    expect(fetcher).toHaveBeenCalledWith(
      new URL('http://api:3000/oauth/token'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: 'support-agent-client',
          client_secret: 'dev-secret-support-agent',
          scope: 'cases:read cases:write',
        }),
      }),
    );
  });

  it('fails with a safe error when the OAuth endpoint rejects credentials', async () => {
    await expect(
      acquireDelegatedToken(
        'http://api:3000',
        'support-agent-client',
        'wrong-secret',
        'cases:read',
        async () => new Response('secret details', { status: 401 }),
      ),
    ).rejects.toThrow('NestJS OAuth token endpoint returned HTTP 401.');
  });
});

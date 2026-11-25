import { LookupAddress } from 'node:dns';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  assertSafeWebhookAddresses,
  parseWebhookTarget,
  UnsafeWebhookTargetError,
  webhookHttpRequestOnce,
} from './webhook-network';

describe('webhook network policy', () => {
  it.each([
    'http://127.0.0.1/callback',
    'http://10.1.2.3/callback',
    'http://169.254.10.2/callback',
    'http://[::1]/callback',
    'http://[fe80::1]/callback',
    'http://[fd00::1]/callback',
    'http://[::ffff:127.0.0.1]/callback',
  ])('rejects private target %s', (url) => {
    expect(() => parseWebhookTarget(url, [])).toThrow(UnsafeWebhookTargetError);
  });

  it('allows private targets only when their exact canonical URL is configured', () => {
    const allowed = 'http://127.0.0.1:8080/events';
    expect(parseWebhookTarget(allowed, [allowed]).href).toBe(allowed);
    expect(() => parseWebhookTarget(`${allowed}/other`, [allowed])).toThrow(UnsafeWebhookTargetError);
  });

  it('rejects a public hostname if any DNS answer is non-public', () => {
    const answers: LookupAddress[] = [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ];

    expect(() =>
      assertSafeWebhookAddresses(new URL('https://callbacks.example/events'), answers, []),
    ).toThrow(UnsafeWebhookTargetError);
  });

  it('does not follow redirects', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(302, { location: 'http://127.0.0.1:1/internal' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/events`;
      const result = await webhookHttpRequestOnce(
        url,
        { headers: { 'content-type': 'application/json' }, body: '{}' },
        1000,
        [url],
      );
      expect(result.status).toBe(302);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

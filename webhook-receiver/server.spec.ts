import { createClient } from '@libsql/client';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeWebhookSignature } from '../src/modules/webhook/webhook-delivery-policy';
import { createLocalWebhookReceiver } from './server';

describe('local webhook receiver', () => {
  const secret = 'whsec_receiver_test_secret_123456';
  const databaseUrl = 'file:./webhook-receiver-test.db';
  const databasePath = resolve(databaseUrl.slice('file:'.length));
  let receiver: Awaited<ReturnType<typeof createLocalWebhookReceiver>> | undefined;
  let targetUrl: string;

  async function startReceiver(): Promise<void> {
    receiver = await createLocalWebhookReceiver({ secret, databaseUrl });
    const port = await receiver.listen(0);
    targetUrl = `http://127.0.0.1:${port}/events`;
  }

  async function stopReceiver(): Promise<void> {
    if (receiver) {
      await receiver.close();
      receiver = undefined;
    }
  }

  beforeAll(() => {
    // libsql can retain a Windows file handle until the Jest process exits.
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const path = `${databasePath}${suffix}`;
      if (existsSync(path)) {
        rmSync(path, { force: true });
      }
    }
  });

  async function sendEvent(
    body: string,
    timestamp: number,
    signatureBody = body,
  ): Promise<Response> {
    return fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': String(timestamp),
        'x-webhook-signature': computeWebhookSignature(secret, timestamp, signatureBody),
      },
      body,
    });
  }

  afterEach(async () => {
    await stopReceiver();
  });

  it('verifies exact-body signatures and fresh timestamps, then durably deduplicates event IDs', async () => {
    await startReceiver();
    const event = JSON.stringify({
      id: 'evt_receiver_test_001',
      specVersion: '1.0',
      type: 'case.escalated',
      occurredAt: new Date().toISOString(),
      data: { id: 'case-001' },
    });
    const now = Math.floor(Date.now() / 1000);

    const tampered = await sendEvent(event.replace('case.escalated', 'case.updated'), now, event);
    expect(tampered.status).toBe(401);
    expect(await tampered.json()).toEqual({ error: 'invalid_signature' });

    const stale = await sendEvent(event, now - 301);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'stale_timestamp' });

    const accepted = await sendEvent(event, now);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ received: true, duplicate: false });

    await stopReceiver();
    await startReceiver();
    const replay = await sendEvent(event, Math.floor(Date.now() / 1000));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ received: true, duplicate: true });

    const db = createClient({ url: databaseUrl });
    try {
      const count = await db.execute('SELECT COUNT(*) AS count FROM webhook_events');
      expect(Number(count.rows[0].count)).toBe(1);
    } finally {
      await db.close();
    }
  });
});

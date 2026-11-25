import { createClient } from '@libsql/client';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { verifyWebhookSignature } from '../src/modules/webhook/webhook-delivery-policy';

const MAX_BODY_BYTES = 1_000_000;

interface ReceiverOptions {
  secret: string;
  databaseUrl: string;
  toleranceSeconds?: number;
}

interface Receiver {
  server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

class PayloadTooLargeError extends Error {}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleEvent(
  request: IncomingMessage,
  response: ServerResponse,
  db: ReturnType<typeof createClient>,
  secret: string,
  toleranceSeconds: number,
): Promise<void> {
  if (!singleHeader(request.headers['content-type'])?.toLowerCase().startsWith('application/json')) {
    sendJson(response, 415, { error: 'unsupported_media_type' });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(response, 413, { error: 'payload_too_large' });
      return;
    }
    throw error;
  }

  const timestampHeader = singleHeader(request.headers['x-webhook-timestamp']);
  const signatureHeader = singleHeader(request.headers['x-webhook-signature']);
  const signatureMatch = signatureHeader?.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
  if (
    !timestampHeader ||
    !/^\d+$/.test(timestampHeader) ||
    !signatureHeader ||
    !signatureMatch ||
    Number(timestampHeader) !== Number(signatureMatch[1])
  ) {
    sendJson(response, 401, { error: 'invalid_signature_headers' });
    return;
  }

  const timestamp = Number(timestampHeader);
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) {
    sendJson(response, 401, { error: 'stale_timestamp' });
    return;
  }
  if (!verifyWebhookSignature(secret, signatureHeader, rawBody)) {
    sendJson(response, 401, { error: 'invalid_signature' });
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    sendJson(response, 400, { error: 'invalid_json' });
    return;
  }
  if (
    typeof event !== 'object' ||
    event === null ||
    !('id' in event) ||
    typeof event.id !== 'string' ||
    event.id.length === 0 ||
    event.id.length > 128 ||
    !('type' in event) ||
    typeof event.type !== 'string' ||
    event.type.length === 0 ||
    event.type.length > 128
  ) {
    sendJson(response, 400, { error: 'invalid_event_envelope' });
    return;
  }

  const inserted = await db.execute({
    sql: `INSERT INTO webhook_events (event_id, event_type, received_at, payload_json)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(event_id) DO NOTHING`,
    args: [event.id, event.type, new Date().toISOString(), rawBody],
  });
  const duplicate = inserted.rowsAffected === 0;
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: duplicate ? 'webhook.receiver.duplicate' : 'webhook.receiver.accepted',
    eventId: event.id,
    eventType: event.type,
  }));
  sendJson(response, 200, { received: true, duplicate });
}

export async function createLocalWebhookReceiver(options: ReceiverOptions): Promise<Receiver> {
  const db = createClient({ url: options.databaseUrl });
  await db.execute(`CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    event_type TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`);

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://webhook-receiver.local').pathname;
    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.method !== 'POST' || pathname !== '/events') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    void handleEvent(
      request,
      response,
      db,
      options.secret,
      options.toleranceSeconds ?? 300,
    ).catch((error: unknown) => {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'webhook.receiver.failed',
        error: error instanceof Error ? error.message : String(error),
      }));
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'receiver_failure' });
      }
    });
  });

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const address = server.address();
          if (address && typeof address !== 'string') {
            resolve(address.port);
          } else {
            reject(new Error('Webhook receiver did not bind a TCP port.'));
          }
        });
      });
    },
    async close() {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await db.close();
    },
  };
}

async function main(): Promise<void> {
  const secret = process.env.WEBHOOK_RECEIVER_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('WEBHOOK_RECEIVER_SECRET must contain at least 16 characters.');
  }
  const port = Number(process.env.WEBHOOK_RECEIVER_PORT ?? '4100');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WEBHOOK_RECEIVER_PORT must be an integer from 1 to 65535.');
  }
  const receiver = await createLocalWebhookReceiver({
    secret,
    databaseUrl: process.env.WEBHOOK_RECEIVER_DATABASE_URL ?? 'file:./webhook-receiver.db',
  });
  const boundPort = await receiver.listen(port);
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'webhook.receiver.started',
    host: '127.0.0.1',
    port: boundPort,
  }));
  process.once('SIGINT', () => {
    void receiver.close().then(() => process.exit(0));
  });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

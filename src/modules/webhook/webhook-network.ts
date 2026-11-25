import { LookupAddress, LookupOptions } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import * as ipaddr from 'ipaddr.js';
import { HttpResult } from '../../common/resilience/http-client';

export class UnsafeWebhookTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeWebhookTargetError';
  }
}

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export function parseWebhookTarget(rawUrl: string, allowedPrivateTargets: readonly string[]): URL {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookTargetError('Webhook URL must be a valid absolute URL.');
  }

  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username.length > 0 ||
    target.password.length > 0 ||
    target.hash.length > 0
  ) {
    throw new UnsafeWebhookTargetError('Webhook URL must use HTTP(S) without credentials or a fragment.');
  }

  const isAllowedPrivateTarget = allowedPrivateTargets.includes(target.href);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (!isAllowedPrivateTarget && isIP(host) !== 0 && !isPublicAddress(host)) {
    throw new UnsafeWebhookTargetError('Webhook URL resolves to a non-public IP address.');
  }

  return target;
}

export function assertSafeWebhookAddresses(
  target: URL,
  addresses: readonly LookupAddress[],
  allowedPrivateTargets: readonly string[],
): void {
  if (addresses.length === 0) {
    throw new UnsafeWebhookTargetError('Webhook hostname did not resolve to an IP address.');
  }
  if (allowedPrivateTargets.includes(target.href)) {
    return;
  }
  if (addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new UnsafeWebhookTargetError('Webhook hostname resolves to a non-public IP address.');
  }
}

async function resolveTargetAddress(
  target: URL,
  allowedPrivateTargets: readonly string[],
): Promise<LookupAddress> {
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(host);
  const addresses =
    literalFamily === 0
      ? await dnsLookup(host, { all: true, verbatim: true })
      : [{ address: host, family: literalFamily }];
  assertSafeWebhookAddresses(target, addresses, allowedPrivateTargets);
  return addresses[0];
}

export async function webhookHttpRequestOnce(
  rawUrl: string,
  init: { headers: Record<string, string>; body: string },
  timeoutMs: number,
  allowedPrivateTargets: readonly string[],
): Promise<HttpResult> {
  const target = parseWebhookTarget(rawUrl, allowedPrivateTargets);
  const address = await resolveTargetAddress(target, allowedPrivateTargets);
  const started = Date.now();
  const pinnedLookup = (
    _hostname: string,
    options: LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    const resolved = { address: address.address, family: address.family };
    if (options.all) {
      callback(null, [resolved]);
    } else {
      callback(null, resolved.address, resolved.family);
    }
  };
  const requestOptions: RequestOptions = {
    hostname: target.hostname.replace(/^\[|\]$/g, ''),
    port: target.port || undefined,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: { ...init.headers, host: target.host },
    lookup: pinnedLookup,
    signal: AbortSignal.timeout(timeoutMs),
  };

  return new Promise<HttpResult>((resolve, reject) => {
    const onResponse = (response: import('node:http').IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) {
            headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
        }
        resolve({
          status: response.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
          durationMs: Date.now() - started,
        });
      });
    };

    const request =
      target.protocol === 'https:'
        ? httpsRequest(requestOptions, onResponse)
        : httpRequest(requestOptions, onResponse);
    request.once('error', reject);
    request.end(init.body);
  });
}

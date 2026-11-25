import { computeWebhookSignature, verifyWebhookSignature } from './webhook-delivery-policy';

describe('webhook signature verification', () => {
  const secret = 'whsec_test_secret_123456789';
  const timestamp = 1_764_045_600;
  const body = '{"id":"evt_1","type":"case.created"}';

  it('accepts the exact signed raw body and rejects altered content or secrets', () => {
    const signature = computeWebhookSignature(secret, timestamp, body);
    expect(verifyWebhookSignature(secret, signature, body)).toBe(true);
    expect(verifyWebhookSignature(secret, signature, `${body} `)).toBe(false);
    expect(verifyWebhookSignature('whsec_other_secret_123456', signature, body)).toBe(false);
    expect(verifyWebhookSignature(secret, 'malformed', body)).toBe(false);
  });
});

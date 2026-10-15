import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvironmentForTests } from '../src/config/environment.js';
import { HttpPaystackGateway } from '../src/services/paystack.service.js';

const secretKey = 'sk_test_this-is-only-a-test-secret';

beforeEach(() => {
  process.env.PAYSTACK_SECRET_KEY = secretKey;
  process.env.PAYSTACK_BASE_URL = 'https://api.paystack.co';
  process.env.PAYSTACK_CALLBACK_URL = 'https://shop.example.com/checkout/result';
  resetEnvironmentForTests();
});

afterEach(() => {
  delete process.env.PAYSTACK_SECRET_KEY;
  delete process.env.PAYSTACK_BASE_URL;
  delete process.env.PAYSTACK_CALLBACK_URL;
  resetEnvironmentForTests();
});

describe('Paystack gateway', () => {
  it('validates webhook HMAC signatures against the untouched request body', () => {
    const rawBody = Buffer.from('{"event":"charge.success","data":{"reference":"KWM-1"}}');
    const signature = createHmac('sha512', secretKey).update(rawBody).digest('hex');
    const gateway = new HttpPaystackGateway();

    expect(gateway.verifyWebhookSignature(rawBody, signature)).toBe(true);
    expect(gateway.verifyWebhookSignature(Buffer.from('{}'), signature)).toBe(false);
    expect(gateway.verifyWebhookSignature(rawBody, 'not-a-signature')).toBe(false);
  });

  it('initializes payments on the server with pesewas and the configured callback URL', async () => {
    let capturedUrl = '';
    let capturedOptions: RequestInit | undefined;
    const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return new Response(JSON.stringify({
        status: true,
        message: 'Authorization URL created',
        data: {
          authorization_url: 'https://checkout.paystack.com/access-code',
          access_code: 'access-code',
          reference: 'KWM-20261014-ABC123',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const gateway = new HttpPaystackGateway(fetcher);

    const result = await gateway.initializeTransaction({
      email: 'customer@example.com',
      amountPesewas: 40_000,
      currency: 'GHS',
      reference: 'KWM-20261014-ABC123',
      metadata: { order_number: 'KWM-20261014-ABC123' },
    });

    expect(capturedUrl).toBe('https://api.paystack.co/transaction/initialize');
    expect(capturedOptions?.headers).toMatchObject({ Authorization: `Bearer ${secretKey}` });
    expect(JSON.parse(String(capturedOptions?.body))).toMatchObject({
      email: 'customer@example.com',
      amount: '40000',
      currency: 'GHS',
      reference: 'KWM-20261014-ABC123',
      callback_url: 'https://shop.example.com/checkout/result',
    });
    expect(result).toEqual({
      authorizationUrl: 'https://checkout.paystack.com/access-code',
      accessCode: 'access-code',
      reference: 'KWM-20261014-ABC123',
    });
  });
});

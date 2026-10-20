import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvironmentForTests } from '../src/config/environment.js';
import { AppError } from '../src/errors/AppError.js';
import { HttpPaystackGateway, type InitializePaystackInput } from '../src/services/paystack.service.js';

function syntheticPaystackKey(kind: 'sk' | 'pk', mode: 'test' | 'live', suffix: string): string {
  return [kind, mode, suffix].join('_');
}

const secretKey = syntheticPaystackKey('sk', 'test', 'unitfixture1234567890abcdef');
const reference = 'KWM-20261014-ABC123';

beforeEach(() => {
  process.env.PAYSTACK_SECRET_KEY = secretKey;
  process.env.PAYSTACK_BASE_URL = 'https://api.paystack.co';
  process.env.PAYSTACK_CALLBACK_URL = 'https://shop.example.com/checkout/result';
  resetEnvironmentForTests();
});

afterEach(() => {
  delete process.env.PAYSTACK_SECRET_KEY;
  delete process.env.PAYSTACK_PUBLIC_KEY;
  delete process.env.PAYSTACK_BASE_URL;
  delete process.env.PAYSTACK_CALLBACK_URL;
  resetEnvironmentForTests();
  vi.restoreAllMocks();
});

function initializationInput(overrides: Partial<InitializePaystackInput> = {}): InitializePaystackInput {
  return {
    email: 'customer@example.com',
    amountPesewas: 40_000,
    currency: 'GHS',
    reference,
    metadata: { order_number: reference },
    requestId: 'request-123',
    ...overrides,
  };
}

function successfulInitializationResponse(responseReference = reference): Response {
  return new Response(JSON.stringify({
    status: true,
    message: 'Authorization URL created',
    data: {
      authorization_url: 'https://checkout.paystack.com/access-code',
      access_code: 'access-code',
      reference: responseReference,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function expectAppError(promise: Promise<unknown>, code: string, status: number): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code, status });
    return error as AppError;
  }
  throw new Error(`Expected ${code}`);
}

describe('Paystack gateway', () => {
  it('validates webhook HMAC signatures against the untouched request body', () => {
    const rawBody = Buffer.from('{"event":"charge.success","data":{"reference":"KWM-1"}}');
    const signature = createHmac('sha512', secretKey).update(rawBody).digest('hex');
    const gateway = new HttpPaystackGateway();

    expect(gateway.verifyWebhookSignature(rawBody, signature, 'request-signature')).toBe(true);
    expect(gateway.verifyWebhookSignature(Buffer.from('{}'), signature, 'request-signature')).toBe(false);
    expect(gateway.verifyWebhookSignature(rawBody, 'not-a-signature', 'request-signature')).toBe(false);
  });

  it('reports missing configuration before initialize or verify sends a request', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    resetEnvironmentForTests();
    const fetcher = vi.fn<typeof fetch>();
    const gateway = new HttpPaystackGateway(fetcher);

    await expectAppError(gateway.initializeTransaction(initializationInput()), 'PAYSTACK_NOT_CONFIGURED', 503);
    await expectAppError(gateway.verifyTransaction(reference, 'request-verify'), 'PAYSTACK_NOT_CONFIGURED', 503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'test placeholder', value: syntheticPaystackKey('sk', 'test', 'replace_me') },
    { label: 'live example placeholder', value: syntheticPaystackKey('sk', 'live', 'example_secret_key') },
    { label: 'public key', value: syntheticPaystackKey('pk', 'test', 'unitfixture1234567890abcdef') },
    { label: 'unrecognized key', value: 'not-a-paystack-key' },
    { label: 'short secret key', value: syntheticPaystackKey('sk', 'test', 'short') },
  ])('rejects invalid configuration: $label', async ({ value }) => {
    process.env.PAYSTACK_SECRET_KEY = value;
    resetEnvironmentForTests();
    const fetcher = vi.fn<typeof fetch>();
    const gateway = new HttpPaystackGateway(fetcher);

    await expectAppError(gateway.initializeTransaction(initializationInput()), 'PAYSTACK_INVALID_CONFIGURATION', 503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'test', value: syntheticPaystackKey('sk', 'test', 'unitfixture1234567890abcdef') },
    { label: 'live', value: syntheticPaystackKey('sk', 'live', 'unitfixture1234567890abcdef') },
  ])('accepts a well-formed $label secret-key fixture', ({ value }) => {
    process.env.PAYSTACK_SECRET_KEY = value;
    resetEnvironmentForTests();
    expect(() => new HttpPaystackGateway().assertConfigured('request-config')).not.toThrow();
  });

  it('initializes payments on the server with pesewas, GHS, the reference, and callback URL', async () => {
    let capturedUrl = '';
    let capturedOptions: RequestInit | undefined;
    const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return successfulInitializationResponse();
    }) as typeof fetch;
    const gateway = new HttpPaystackGateway(fetcher);

    const result = await gateway.initializeTransaction(initializationInput());

    expect(capturedUrl).toBe('https://api.paystack.co/transaction/initialize');
    expect(capturedOptions?.headers).toMatchObject({ Authorization: `Bearer ${secretKey}` });
    expect(JSON.parse(String(capturedOptions?.body))).toMatchObject({
      email: 'customer@example.com',
      amount: '40000',
      currency: 'GHS',
      reference,
      callback_url: 'https://shop.example.com/checkout/result',
    });
    expect(result).toEqual({
      authorizationUrl: 'https://checkout.paystack.com/access-code',
      accessCode: 'access-code',
      reference,
    });
  });

  it.each([401, 403])('maps Paystack HTTP %s to an authentication failure without exposing its body', async (status) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const providerBody = `Rejected credential ${secretKey}`;
    const gateway = new HttpPaystackGateway((async () => new Response(
      JSON.stringify({ status: false, message: providerBody }),
      { status, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch);

    const error = await expectAppError(
      gateway.initializeTransaction(initializationInput()),
      'PAYSTACK_AUTHENTICATION_FAILED',
      502,
    );

    expect(error.message).not.toContain(providerBody);
    const logLine = log.mock.calls.map(([entry]) => String(entry)).find((entry) => entry.includes('paystack_operation_failed'));
    expect(logLine).toBeDefined();
    expect(JSON.parse(logLine!)).toMatchObject({
      metadata: {
        operation: 'initialize_transaction',
        code: 'PAYSTACK_AUTHENTICATION_FAILED',
        providerStatus: status,
        requestId: 'request-123',
      },
    });
    expect(logLine).not.toContain(secretKey);
    expect(logLine).not.toContain(providerBody);
    expect(logLine).not.toContain('customer@example.com');
  });

  it('distinguishes a timeout from other connection failures', async () => {
    const timeoutError = new Error('provider took too long');
    timeoutError.name = 'TimeoutError';
    const timeoutGateway = new HttpPaystackGateway((async () => {
      throw timeoutError;
    }) as typeof fetch);
    await expectAppError(timeoutGateway.initializeTransaction(initializationInput()), 'PAYSTACK_TIMEOUT', 504);

    const connectionGateway = new HttpPaystackGateway((async () => {
      throw new TypeError('connection reset');
    }) as typeof fetch);
    await expectAppError(
      connectionGateway.initializeTransaction(initializationInput()),
      'PAYSTACK_CONNECTION_FAILED',
      502,
    );
  });

  it('rejects a non-JSON success response as an invalid provider response', async () => {
    const gateway = new HttpPaystackGateway((async () => new Response(
      '<html>not json</html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )) as typeof fetch);

    await expectAppError(gateway.initializeTransaction(initializationInput()), 'PAYSTACK_INVALID_RESPONSE', 502);
  });

  it('rejects malformed JSON and a mismatched reference as invalid provider responses', async () => {
    const malformedGateway = new HttpPaystackGateway((async () => new Response(
      JSON.stringify({ status: true, message: 'ok', data: { reference } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch);
    await expectAppError(
      malformedGateway.initializeTransaction(initializationInput()),
      'PAYSTACK_INVALID_RESPONSE',
      502,
    );

    const mismatchedGateway = new HttpPaystackGateway((async () =>
      successfulInitializationResponse('KWM-WRONG-REFERENCE')) as typeof fetch);
    await expectAppError(
      mismatchedGateway.initializeTransaction(initializationInput()),
      'PAYSTACK_INVALID_RESPONSE',
      502,
    );
  });
});

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getEnvironment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';
import { logger } from '../utils/logger.js';

const initializeResponseSchema = z.object({
  status: z.literal(true),
  message: z.string(),
  data: z.object({
    authorization_url: z.string().url(),
    access_code: z.string().min(1),
    reference: z.string().min(1),
  }),
});

const verifyResponseSchema = z.object({
  status: z.literal(true),
  message: z.string(),
  data: z.object({
    id: z.union([z.string(), z.number()]),
    status: z.string(),
    reference: z.string(),
    amount: z.number().int().nonnegative(),
    currency: z.string(),
    paid_at: z.string().nullable().optional(),
    customer: z.object({ email: z.string().optional() }).passthrough().optional(),
  }).passthrough(),
});

export interface InitializePaystackInput {
  email: string;
  amountPesewas: number;
  currency: 'GHS';
  reference: string;
  metadata: Record<string, string>;
  requestId?: string;
}

export interface PaystackInitialization {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface PaystackVerification {
  transactionId: string;
  status: string;
  reference: string;
  amountPesewas: number;
  currency: string;
  paidAt?: Date | undefined;
  customerEmail?: string | undefined;
}

export interface PaystackGateway {
  assertConfigured(requestId?: string): void;
  initializeTransaction(input: InitializePaystackInput): Promise<PaystackInitialization>;
  verifyTransaction(reference: string, requestId?: string): Promise<PaystackVerification>;
  verifyWebhookSignature(rawBody: Buffer, signature: string, requestId?: string): boolean;
}

type PaystackOperation = 'configure_checkout' | 'initialize_transaction' | 'verify_transaction' | 'verify_webhook_signature';

interface PaystackConfiguration {
  secretKey: string;
  baseUrl: string;
  callbackUrl?: string;
}

const secretKeyPattern = /^sk_(?:test|live)_[A-Za-z0-9_-]{16,}$/;
const publicKeyPattern = /^pk_(?:test|live)_/i;
const placeholderPattern = /(?:replace(?:[_-]?me)?|placeholder|example|your[_-]?(?:key|secret)|change[_-]?me|dummy|sample|x{4,})/i;

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export class HttpPaystackGateway implements PaystackGateway {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }

  assertConfigured(requestId?: string): void {
    this.configuration('configure_checkout', requestId);
  }

  async initializeTransaction(input: InitializePaystackInput): Promise<PaystackInitialization> {
    const configuration = this.configuration('initialize_transaction', input.requestId);
    let response: Response;
    try {
      response = await this.fetcher(`${configuration.baseUrl}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${configuration.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: input.email,
          amount: String(input.amountPesewas),
          currency: input.currency,
          reference: input.reference,
          metadata: JSON.stringify(input.metadata),
          ...(configuration.callbackUrl ? { callback_url: configuration.callbackUrl } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isTimeoutError(error)) {
        throw this.failure(
          'initialize_transaction',
          504,
          'PAYSTACK_TIMEOUT',
          'Paystack did not respond in time. Keep this checkout and try it again shortly.',
          input.requestId,
        );
      }
      throw this.failure(
        'initialize_transaction',
        502,
        'PAYSTACK_CONNECTION_FAILED',
        'Paystack could not be reached. Keep this checkout and try it again shortly.',
        input.requestId,
      );
    }

    if (!response.ok) {
      throw this.providerHttpFailure('initialize_transaction', response.status, input.requestId);
    }
    const payload = await this.parseResponse(response, 'initialize_transaction', input.requestId);
    const parsed = initializeResponseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.data.reference !== input.reference) {
      throw this.failure(
        'initialize_transaction',
        502,
        'PAYSTACK_INVALID_RESPONSE',
        'Paystack returned an invalid initialization response. Keep this checkout and try again shortly.',
        input.requestId,
        response.status,
      );
    }
    return {
      authorizationUrl: parsed.data.data.authorization_url,
      accessCode: parsed.data.data.access_code,
      reference: parsed.data.data.reference,
    };
  }

  async verifyTransaction(reference: string, requestId?: string): Promise<PaystackVerification> {
    const configuration = this.configuration('verify_transaction', requestId);
    let response: Response;
    try {
      response = await this.fetcher(
        `${configuration.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
        {
          headers: { Authorization: `Bearer ${configuration.secretKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isTimeoutError(error)) {
        throw this.failure(
          'verify_transaction',
          504,
          'PAYSTACK_TIMEOUT',
          'Paystack did not respond in time while verifying the payment.',
          requestId,
        );
      }
      throw this.failure(
        'verify_transaction',
        502,
        'PAYSTACK_CONNECTION_FAILED',
        'Paystack could not be reached while verifying the payment.',
        requestId,
      );
    }

    if (!response.ok) {
      throw this.providerHttpFailure('verify_transaction', response.status, requestId);
    }
    const payload = await this.parseResponse(response, 'verify_transaction', requestId);
    const parsed = verifyResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw this.failure(
        'verify_transaction',
        502,
        'PAYSTACK_INVALID_RESPONSE',
        'Paystack returned an invalid verification response.',
        requestId,
        response.status,
      );
    }
    const { data } = parsed.data;
    return {
      transactionId: String(data.id),
      status: data.status,
      reference: data.reference,
      amountPesewas: data.amount,
      currency: data.currency,
      ...(data.paid_at ? { paidAt: new Date(data.paid_at) } : {}),
      ...(data.customer?.email ? { customerEmail: data.customer.email.toLowerCase() } : {}),
    };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string, requestId?: string): boolean {
    if (!/^[a-f\d]{128}$/i.test(signature)) return false;
    const configuration = this.configuration('verify_webhook_signature', requestId);
    const expected = Buffer.from(
      createHmac('sha512', configuration.secretKey).update(rawBody).digest('hex'),
      'hex',
    );
    const received = Buffer.from(signature, 'hex');
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  private configuration(operation: PaystackOperation, requestId?: string): PaystackConfiguration {
    const environment = getEnvironment();
    const secretKey = environment.PAYSTACK_SECRET_KEY?.trim();
    if (!secretKey) {
      throw this.failure(
        operation,
        503,
        'PAYSTACK_NOT_CONFIGURED',
        'Online payment is temporarily unavailable.',
        requestId,
      );
    }
    if (publicKeyPattern.test(secretKey) || placeholderPattern.test(secretKey) || !secretKeyPattern.test(secretKey)) {
      throw this.failure(
        operation,
        503,
        'PAYSTACK_INVALID_CONFIGURATION',
        'Online payment is temporarily unavailable.',
        requestId,
      );
    }

    const baseUrl = this.validHttpsUrl(environment.PAYSTACK_BASE_URL);
    const callbackUrl = environment.PAYSTACK_CALLBACK_URL
      ? this.validCallbackUrl(environment.PAYSTACK_CALLBACK_URL)
      : undefined;
    if (!baseUrl || (environment.PAYSTACK_CALLBACK_URL && !callbackUrl)) {
      throw this.failure(
        operation,
        503,
        'PAYSTACK_INVALID_CONFIGURATION',
        'Online payment is temporarily unavailable.',
        requestId,
      );
    }
    return {
      secretKey,
      baseUrl: baseUrl.replace(/\/$/, ''),
      ...(callbackUrl ? { callbackUrl } : {}),
    };
  }

  private validHttpsUrl(value: string): string | undefined {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }

  private validCallbackUrl(value: string): string | undefined {
    try {
      const url = new URL(value);
      const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return (url.protocol === 'https:' || localHttp) && !url.username && !url.password ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }

  private async parseResponse(
    response: Response,
    operation: PaystackOperation,
    requestId?: string,
  ): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw this.failure(
        operation,
        502,
        'PAYSTACK_INVALID_RESPONSE',
        'Paystack returned an unreadable response.',
        requestId,
        response.status,
      );
    }
  }

  private providerHttpFailure(operation: PaystackOperation, providerStatus: number, requestId?: string): AppError {
    if (providerStatus === 401 || providerStatus === 403) {
      return this.failure(
        operation,
        502,
        'PAYSTACK_AUTHENTICATION_FAILED',
        'The payment service rejected the server credentials.',
        requestId,
        providerStatus,
      );
    }
    if (providerStatus >= 500) {
      return this.failure(
        operation,
        502,
        'PAYSTACK_PROVIDER_ERROR',
        'Paystack could not complete the request. Keep this checkout and try again shortly.',
        requestId,
        providerStatus,
      );
    }
    const initialization = operation === 'initialize_transaction';
    return this.failure(
      operation,
      502,
      initialization ? 'PAYSTACK_INITIALIZATION_REJECTED' : 'PAYSTACK_VERIFICATION_REJECTED',
      initialization ? 'Paystack rejected this payment request.' : 'Paystack could not verify this payment.',
      requestId,
      providerStatus,
    );
  }

  private failure(
    operation: PaystackOperation,
    status: number,
    code: string,
    message: string,
    requestId?: string,
    providerStatus?: number,
  ): AppError {
    logger.error('paystack_operation_failed', { operation, code, providerStatus, requestId });
    return new AppError(status, code, message);
  }
}

export const paystackGateway = new HttpPaystackGateway();

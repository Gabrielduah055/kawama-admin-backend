import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getEnvironment, requireEnvironment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';

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
  initializeTransaction(input: InitializePaystackInput): Promise<PaystackInitialization>;
  verifyTransaction(reference: string): Promise<PaystackVerification>;
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

type ErrorPayload = { message?: unknown };

async function parseResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AppError(502, 'PAYSTACK_INVALID_RESPONSE', 'Paystack returned an unreadable response.');
  }
}

function providerMessage(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const message = (payload as ErrorPayload).message;
  return typeof message === 'string' ? message : undefined;
}

export class HttpPaystackGateway implements PaystackGateway {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }

  async initializeTransaction(input: InitializePaystackInput): Promise<PaystackInitialization> {
    const environment = getEnvironment();
    let response: Response;
    try {
      response = await this.fetcher(`${environment.PAYSTACK_BASE_URL}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${requireEnvironment('PAYSTACK_SECRET_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: input.email,
          amount: String(input.amountPesewas),
          currency: input.currency,
          reference: input.reference,
          metadata: JSON.stringify(input.metadata),
          ...(environment.PAYSTACK_CALLBACK_URL ? { callback_url: environment.PAYSTACK_CALLBACK_URL } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError(502, 'PAYSTACK_UNAVAILABLE', 'Paystack could not be reached. Please try again.');
    }

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new AppError(
        502,
        'PAYSTACK_INITIALIZATION_FAILED',
        providerMessage(payload) ?? 'Paystack could not initialize this payment.',
      );
    }
    const parsed = initializeResponseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.data.reference !== input.reference) {
      throw new AppError(502, 'PAYSTACK_INVALID_RESPONSE', 'Paystack returned an invalid initialization response.');
    }
    return {
      authorizationUrl: parsed.data.data.authorization_url,
      accessCode: parsed.data.data.access_code,
      reference: parsed.data.data.reference,
    };
  }

  async verifyTransaction(reference: string): Promise<PaystackVerification> {
    const environment = getEnvironment();
    let response: Response;
    try {
      response = await this.fetcher(
        `${environment.PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
        {
          headers: { Authorization: `Bearer ${requireEnvironment('PAYSTACK_SECRET_KEY')}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new AppError(502, 'PAYSTACK_UNAVAILABLE', 'Paystack could not be reached while verifying the payment.');
    }

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new AppError(
        502,
        'PAYSTACK_VERIFICATION_FAILED',
        providerMessage(payload) ?? 'Paystack could not verify this payment.',
      );
    }
    const parsed = verifyResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError(502, 'PAYSTACK_INVALID_RESPONSE', 'Paystack returned an invalid verification response.');
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

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!/^[a-f\d]{128}$/i.test(signature)) return false;
    const expected = Buffer.from(
      createHmac('sha512', requireEnvironment('PAYSTACK_SECRET_KEY')).update(rawBody).digest('hex'),
      'hex',
    );
    const received = Buffer.from(signature, 'hex');
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
}

export const paystackGateway = new HttpPaystackGateway();

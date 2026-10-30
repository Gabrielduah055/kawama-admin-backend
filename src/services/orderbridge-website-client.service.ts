import { z } from 'zod';
import { AppError } from '../errors/AppError.js';

const conversationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const conversationTokenSchema = z.string().regex(/^v1\.[A-Za-z0-9_-]{43}$/);
const commerceFactFreshnessSchema = z.enum(['live', 'cached', 'unverified']);

const orderBridgeProductSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string().trim().min(1).max(300),
  price: z.number().nonnegative().optional(),
  currency: z.string().trim().min(3).max(8).optional(),
  available: z.boolean().optional(),
  canonicalUrl: z.string().url().refine((value) => new URL(value).protocol === 'https:'),
}).passthrough();

const responseSchema = z.object({
  success: z.boolean(),
  message: z.string().trim().min(1).max(8_000),
  data: z.object({
    products: z.array(orderBridgeProductSchema).max(20).optional(),
    product: orderBridgeProductSchema.optional(),
    commerceDataFreshness: z.object({
      products: z.array(z.object({
        productId: z.union([z.string(), z.number()]).transform(String),
        price: commerceFactFreshnessSchema,
        availability: commerceFactFreshnessSchema,
      })).max(20).optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  conversation: z.object({
    conversationId: conversationIdSchema,
    conversationToken: conversationTokenSchema,
  }),
}).passthrough();

export interface OrderBridgeConversationIdentity {
  conversationId: string;
  conversationToken: string;
}

export interface OrderBridgeWebsiteMessage {
  message: string;
  conversation?: OrderBridgeConversationIdentity | undefined;
  requestId?: string | undefined;
}

export type OrderBridgeWebsiteResponse = z.infer<typeof responseSchema>;

export interface OrderBridgeWebsiteClient {
  readonly businessId: string | undefined;
  sendMessage(input: OrderBridgeWebsiteMessage): Promise<OrderBridgeWebsiteResponse>;
}

export interface OrderBridgeWebsiteClientConfiguration {
  baseUrl?: string | undefined;
  businessId?: string | undefined;
  integrationKey?: string | undefined;
  timeoutMs: number;
  allowInsecureLocalhost?: boolean | undefined;
}

type FetchImplementation = typeof fetch;

const unavailable = (): AppError => new AppError(
  503,
  'ORDERBRIDGE_CHAT_UNAVAILABLE',
  'The shopping assistant is temporarily unavailable.',
);

function resolveEndpoint(configuration: OrderBridgeWebsiteClientConfiguration): URL {
  const { baseUrl, businessId, integrationKey } = configuration;
  if (!baseUrl || !businessId || !integrationKey) {
    throw new AppError(
      503,
      'ORDERBRIDGE_CHAT_NOT_CONFIGURED',
      'The shopping assistant is temporarily unavailable.',
    );
  }
  if (!/^[a-fA-F0-9]{24}$/.test(businessId) || integrationKey.length < 32) throw unavailable();

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw unavailable();
  }
  const isLocalHttp = configuration.allowInsecureLocalhost === true
    && base.protocol === 'http:'
    && ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !isLocalHttp) || base.username || base.password) {
    throw unavailable();
  }
  return new URL(`/api/integrations/website-chat/${encodeURIComponent(businessId)}/messages`, base.origin);
}

export function createOrderBridgeWebsiteClient(
  configuration: OrderBridgeWebsiteClientConfiguration,
  fetchImpl: FetchImplementation = fetch,
): OrderBridgeWebsiteClient {
  return {
    businessId: configuration.businessId,
    async sendMessage(input) {
      const endpoint = resolveEndpoint(configuration);
      const body = {
        message: input.message,
        ...(input.conversation
          ? {
              conversationId: input.conversation.conversationId,
              conversationToken: input.conversation.conversationToken,
            }
          : {}),
      };

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${configuration.integrationKey}`,
            ...(input.requestId ? { 'X-Request-Id': input.requestId } : {}),
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(configuration.timeoutMs),
        });
      } catch {
        throw unavailable();
      }

      if (!response.ok) throw unavailable();

      let parsed: unknown;
      try {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > 512 * 1_024) throw unavailable();
        parsed = JSON.parse(text);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw unavailable();
      }
      const result = responseSchema.safeParse(parsed);
      if (!result.success || !result.data.success) throw unavailable();
      return result.data;
    },
  };
}

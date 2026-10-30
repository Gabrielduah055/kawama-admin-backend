import { AppError } from '../errors/AppError.js';
import { getEnvironment } from '../config/environment.js';
import { OrderBridgeChatSessionModel } from '../models/OrderBridgeChatSessionSchema.js';
import { getPublicProductsByIdentifiers } from './catalog.service.js';
import {
  conversationExpiry,
  newSessionToken,
  sessionHash,
  toProductCard,
  type ChatInput,
  type ProductCard,
  type ShoppingChatResult,
} from './chat.service.js';
import type {
  OrderBridgeWebsiteClient,
  OrderBridgeWebsiteResponse,
} from './orderbridge-website-client.service.js';

type ProductLookup = typeof getPublicProductsByIdentifiers;

function selectedProducts(response: OrderBridgeWebsiteResponse) {
  const candidates = [
    ...(response.data?.product ? [response.data.product] : []),
    ...(response.data?.products ?? []),
  ];
  const seen = new Set<string>();
  return candidates.filter((product) => {
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return product.currency === undefined || product.currency === 'GHS';
  }).slice(0, 4);
}

export async function mapProductCards(
  response: OrderBridgeWebsiteResponse,
  getProducts: ProductLookup = getPublicProductsByIdentifiers,
): Promise<ProductCard[]> {
  const products = selectedProducts(response);
  if (products.length === 0) return [];
  const localProducts = await getProducts(products.map((product) => product.id));
  const byId = new Map(localProducts.map((product) => [String(product.id), product]));
  const freshnessById = new Map(
    (response.data?.commerceDataFreshness?.products ?? [])
      .map((freshness) => [freshness.productId, freshness] as const),
  );
  return products.flatMap((product) => {
    const localProduct = byId.get(product.id);
    if (!localProduct) return [];
    const localCard = toProductCard(localProduct);
    const freshness = freshnessById.get(product.id);
    const price = freshness?.price === 'live' && typeof product.price === 'number'
      ? product.price
      : localCard.price;
    const availability = freshness?.availability === 'live' && typeof product.available === 'boolean'
      ? (product.available
          ? (localCard.availability === 'low_stock' ? 'low_stock' : 'in_stock')
          : 'out_of_stock')
      : localCard.availability;
    return [{
      ...localCard,
      price,
      availability,
      url: product.canonicalUrl,
    }];
  });
}

export async function buildOrderBridgeMessage(
  input: ChatInput,
  getProducts: ProductLookup = getPublicProductsByIdentifiers,
): Promise<string> {
  const identifiers = [input.context?.productId, input.context?.productSlug]
    .filter((identifier): identifier is string => typeof identifier === 'string');
  if (identifiers.length === 0) return input.message;

  const products = await getProducts(identifiers);
  const uniqueProducts = new Map(products.map((product) => [String(product.id), product]));
  if (uniqueProducts.size !== 1) return input.message;
  const product = [...uniqueProducts.values()][0]!;
  return [
    `Kawama catalog product page: ${String(product.name)} (product ID: ${String(product.id)}; slug: ${String(product.slug)}).`,
    `Customer message: ${input.message}`,
  ].join('\n');
}

export async function runOrderBridgeShoppingChat(
  input: ChatInput,
  providedSessionToken: string | undefined,
  client: OrderBridgeWebsiteClient,
  requestId?: string,
): Promise<ShoppingChatResult> {
  if (!getEnvironment().AI_CHAT_ENABLED) {
    throw new AppError(503, 'AI_CHAT_DISABLED', 'The shopping assistant is currently disabled.');
  }
  const businessId = client.businessId;
  if (!businessId) {
    throw new AppError(
      503,
      'ORDERBRIDGE_CHAT_NOT_CONFIGURED',
      'The shopping assistant is temporarily unavailable.',
    );
  }

  const sessionToken = providedSessionToken ?? newSessionToken();
  const ownerHash = sessionHash(sessionToken);
  const now = new Date();
  const existing = input.conversationId
    ? await OrderBridgeChatSessionModel.findOne({
        _id: input.conversationId,
        ownerHash,
        businessId,
        expiresAt: { $gt: now },
      }).select('+upstreamConversationId +upstreamConversationToken')
    : null;
  if (input.conversationId && !existing) {
    throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'The conversation was not found.');
  }

  const response = await client.sendMessage({
    message: await buildOrderBridgeMessage(input),
    ...(existing
      ? {
          conversation: {
            conversationId: String(existing.upstreamConversationId),
            conversationToken: String(existing.upstreamConversationToken),
          },
        }
      : {}),
    ...(requestId ? { requestId } : {}),
  });

  const conversation = existing ?? await OrderBridgeChatSessionModel.create({
    ownerHash,
    businessId,
    upstreamConversationId: response.conversation.conversationId,
    upstreamConversationToken: response.conversation.conversationToken,
    expiresAt: conversationExpiry(),
  });
  if (existing) {
    existing.expiresAt = conversationExpiry();
    await existing.save();
  }

  return {
    conversationId: String(conversation._id),
    sessionToken,
    assistantMessage: response.message,
    products: await mapProductCards(response),
    // The current OrderBridge website response contract has no structured
    // follow-up suggestions, so the existing frontend field is left empty.
    suggestedFollowUps: [],
  };
}

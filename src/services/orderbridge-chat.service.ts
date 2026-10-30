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

function verifiedProducts(response: OrderBridgeWebsiteResponse) {
  const candidates = [
    ...(response.data?.products ?? []),
    ...(response.data?.product ? [response.data.product] : []),
  ];
  const seen = new Set<string>();
  return candidates.filter((product) => {
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return product.currency === 'GHS'
      && typeof product.price === 'number'
      && typeof product.available === 'boolean';
  }).slice(0, 4);
}

async function mapProductCards(response: OrderBridgeWebsiteResponse): Promise<ProductCard[]> {
  const products = verifiedProducts(response);
  if (products.length === 0) return [];
  const localProducts = await getPublicProductsByIdentifiers(products.map((product) => product.id));
  const byId = new Map(localProducts.map((product) => [String(product.id), product]));
  return products.flatMap((product) => {
    const localProduct = byId.get(product.id);
    if (!localProduct) return [];
    const localCard = toProductCard(localProduct);
    return [{
      ...localCard,
      name: product.name,
      price: product.price!,
      availability: product.available
        ? (localCard.availability === 'low_stock' ? 'low_stock' : 'in_stock')
        : 'out_of_stock',
      url: product.canonicalUrl,
    }];
  });
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
    message: input.message,
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

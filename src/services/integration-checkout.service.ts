import { randomBytes } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { z } from 'zod';
import { getEnvironment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';
import { hashCheckoutToken } from '../lib/orders.js';
import { IntegrationCheckoutQuoteModel } from '../models/IntegrationCheckoutQuoteSchema.js';
import { OrderModel } from '../models/OrderSchema.js';
import { ProductModel } from '../models/ProductSchema.js';
import type { integrationCheckoutCreateSchema, integrationQuoteCreateSchema } from '../validation/integration-checkout.schemas.js';
import {
  createCheckoutSession,
  getCheckoutStatusByHash,
  type CheckoutSession,
  type CreateCheckoutSessionOptions,
} from './checkout.service.js';
import type { PendingOrderDraft } from './order.service.js';
import type { PaystackGateway } from './paystack.service.js';

const QUOTE_TTL_MS = 10 * 60_000;

export type IntegrationQuoteInput = z.infer<typeof integrationQuoteCreateSchema>;
export type IntegrationCheckoutInput = z.infer<typeof integrationCheckoutCreateSchema>;

function assertCheckoutEnabled(): void {
  if (!getEnvironment().ORDERBRIDGE_CHECKOUT_ENABLED) {
    throw new AppError(
      503,
      'ORDERBRIDGE_CHECKOUT_NOT_ENABLED',
      'WhatsApp purchasing through OrderBridge is not enabled.',
    );
  }
}

function resolveBusinessId(): string {
  const businessId = getEnvironment().ORDERBRIDGE_BUSINESS_ID;
  if (!businessId) {
    throw new AppError(
      503,
      'ORDERBRIDGE_CHECKOUT_NOT_CONFIGURED',
      'The OrderBridge checkout business scope is not configured.',
    );
  }
  return businessId.toLowerCase();
}

function resolveWhatsAppCallbackUrl(): string {
  const configured = getEnvironment().ORDERBRIDGE_WHATSAPP_CALLBACK_URL;
  if (!configured) {
    throw new AppError(
      503,
      'ORDERBRIDGE_CHECKOUT_NOT_CONFIGURED',
      'The WhatsApp payment callback URL is not configured.',
    );
  }
  try {
    const url = new URL(configured);
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password) throw new Error('invalid');
    return url.toString();
  } catch {
    throw new AppError(
      503,
      'ORDERBRIDGE_CHECKOUT_NOT_CONFIGURED',
      'The WhatsApp payment callback URL is invalid.',
    );
  }
}

function generateSessionId(): string {
  return `obs_${randomBytes(16).toString('hex')}`;
}

function duplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function assertQuoteOwnership(quote: any, businessId: string, customerKey: string): void {
  if (quote.businessId !== businessId || quote.customerKey !== customerKey) {
    throw new AppError(403, 'QUOTE_ACCESS_DENIED', 'This quote is not available to the specified customer.');
  }
}

function assertOrderBinding(order: any, quoteId: string, businessId: string, customerKey: string): void {
  if (
    String(order.integrationQuoteId ?? '') !== quoteId
    || order.integrationBusinessId !== businessId
    || order.integrationCustomerKey !== customerKey
    || !order.integrationSessionId
  ) {
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
      'This Idempotency-Key is already bound to a different checkout.',
    );
  }
}

function assertQuoteMatchesDraft(quote: any, draft: PendingOrderDraft): void {
  const quotedItems = new Map(quote.items.map((item: any) => [String(item.productId), item]));
  const itemsMatch = draft.items.length === quote.items.length && draft.items.every((item) => {
    const quoted = quotedItems.get(String(item.product)) as any;
    return quoted
      && quoted.slug === item.slug
      && quoted.name === item.name
      && quoted.quantity === item.quantity
      && quoted.unitPricePesewas === item.unitPricePesewas
      && quoted.lineTotalPesewas === item.lineTotalPesewas;
  });
  if (
    !itemsMatch
    || draft.currency !== quote.currency
    || draft.subtotalPesewas !== quote.subtotalPesewas
    || draft.productPaymentTotalPesewas !== quote.totalPesewas
  ) {
    throw new AppError(
      409,
      'QUOTE_CHANGED',
      'The confirmed purchase has changed. Create a new quote and obtain fresh customer confirmation.',
    );
  }
}

async function loadOwnedQuote(quoteId: string, businessId: string, customerKey: string): Promise<any> {
  const quote = await IntegrationCheckoutQuoteModel.findById(quoteId).select('+checkoutKeyHash').lean();
  if (!quote) throw new AppError(404, 'QUOTE_NOT_FOUND', 'The requested quote does not exist.');
  assertQuoteOwnership(quote, businessId, customerKey);
  return quote;
}

async function bindQuoteToCheckout(
  quote: any,
  checkoutKeyHash: string,
  businessId: string,
  customerKey: string,
): Promise<any> {
  const keyBinding = await IntegrationCheckoutQuoteModel.findOne({ checkoutKeyHash })
    .select('+checkoutKeyHash')
    .lean();
  if (keyBinding && String(keyBinding._id) !== String(quote._id)) {
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
      'This Idempotency-Key is already bound to a different quote.',
    );
  }
  if (quote.checkoutKeyHash) {
    if (quote.checkoutKeyHash !== checkoutKeyHash) {
      throw new AppError(409, 'QUOTE_ALREADY_BOUND', 'This quote is already bound to another checkout attempt.');
    }
    if (quote.integrationSessionId) return quote;
    throw new AppError(409, 'QUOTE_BINDING_LOST', 'The quote binding is incomplete.');
  }

  try {
    const bound = await IntegrationCheckoutQuoteModel.findOneAndUpdate(
      {
        _id: quote._id,
        businessId,
        customerKey,
        expiresAt: { $gt: new Date() },
        checkoutState: 'open',
        checkoutKeyHash: { $exists: false },
      },
      {
        $set: {
          checkoutKeyHash,
          checkoutState: 'bound',
          integrationSessionId: generateSessionId(),
          consumedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    ).select('+checkoutKeyHash').lean();
    if (bound) return bound;
  } catch (error) {
    if (!duplicateKeyError(error)) throw error;
  }

  const current = await loadOwnedQuote(String(quote._id), businessId, customerKey);
  if (current.checkoutKeyHash === checkoutKeyHash && current.integrationSessionId) return current;
  if (current.checkoutKeyHash) {
    throw new AppError(409, 'QUOTE_ALREADY_BOUND', 'This quote is already bound to another checkout attempt.');
  }
  if (current.expiresAt <= new Date()) {
    throw new AppError(
      409,
      'QUOTE_EXPIRED',
      'This quote has expired. Create a new quote and obtain fresh customer confirmation.',
    );
  }
  throw new AppError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'This Idempotency-Key is already bound to another checkout.');
}

export interface IntegrationQuote {
  quoteId: string;
  items: Array<{
    productId: string;
    name: string;
    unitPricePesewas: number;
    quantity: number;
    lineTotalPesewas: number;
  }>;
  subtotalPesewas: number;
  totalPesewas: number;
  currency: 'GHS';
  deliveryFee: 'arranged_separately';
  expiresAt: string;
}

export async function createIntegrationQuote(input: IntegrationQuoteInput): Promise<IntegrationQuote> {
  assertCheckoutEnabled();
  const businessId = resolveBusinessId();
  const productIds = input.items.map((item) => item.productId);
  const products = await ProductModel.find({ _id: { $in: productIds }, status: 'active' }).lean();
  const productsById = new Map(products.map((product) => [String(product._id), product]));
  const unavailable = productIds.filter((productId) => !productsById.has(productId));
  if (unavailable.length > 0) {
    throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'One or more products are no longer available.', {
      productIds: unavailable,
    });
  }

  const insufficientStock = input.items.flatMap((item) => {
    const product = productsById.get(item.productId)!;
    const available = Math.max(0, product.stockQuantity - (product.reservedQuantity ?? 0));
    return available < item.quantity ? [{ productId: item.productId, available, requested: item.quantity }] : [];
  });
  if (insufficientStock.length > 0) {
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'One or more products do not have enough stock.', {
      items: insufficientStock,
    });
  }

  const items = input.items.map((item) => {
    const product = productsById.get(item.productId)!;
    const image = [...(product.images ?? [])].sort((first: any, second: any) => first.position - second.position)[0];
    return {
      productId: String(product._id),
      slug: product.slug,
      name: product.name,
      ...(image ? { image: { src: image.src, alt: image.alt } } : {}),
      unitPricePesewas: product.pricePesewas,
      quantity: item.quantity,
      lineTotalPesewas: product.pricePesewas * item.quantity,
    };
  });
  const subtotalPesewas = items.reduce((total, item) => total + item.lineTotalPesewas, 0);
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS);
  const quote = await IntegrationCheckoutQuoteModel.create({
    businessId,
    customerKey: input.customerKey,
    customer: input.customer,
    orderNotes: input.orderNotes,
    items,
    currency: 'GHS',
    subtotalPesewas,
    totalPesewas: subtotalPesewas,
    expiresAt,
  });

  return {
    quoteId: String(quote._id),
    items: items.map(({ productId, name, unitPricePesewas, quantity, lineTotalPesewas }) => ({
      productId,
      name,
      unitPricePesewas,
      quantity,
      lineTotalPesewas,
    })),
    subtotalPesewas,
    totalPesewas: subtotalPesewas,
    currency: 'GHS',
    deliveryFee: 'arranged_separately',
    expiresAt: expiresAt.toISOString(),
  };
}

export interface IntegrationCheckoutSession {
  created: boolean;
  sessionId: string;
  orderNumber: string;
  amountPesewas: number;
  currency: 'GHS';
  paymentStatus: string;
  fulfillmentStatus: string;
  deliveryFee: 'arranged_separately';
  paymentUrl?: string;
}

export async function createIntegrationCheckoutSession(
  input: IntegrationCheckoutInput,
  idempotencyKey: string,
  gateway: PaystackGateway,
  requestId?: string,
): Promise<IntegrationCheckoutSession> {
  assertCheckoutEnabled();
  const businessId = resolveBusinessId();
  const checkoutKeyHash = hashCheckoutToken(idempotencyKey);
  const existingOrder = await OrderModel.findOne({ idempotencyKeyHash: checkoutKeyHash }).lean();
  if (existingOrder) {
    assertOrderBinding(existingOrder, input.quoteId, businessId, input.customerKey);
    const session = await createCheckoutSession(
      checkoutInputFromOrder(existingOrder),
      idempotencyKey,
      gateway,
      requestId,
      checkoutOptions(
        input.quoteId,
        existingOrder.integrationSessionId,
        businessId,
        input.customerKey,
      ),
    );
    return mapToIntegrationSession(session, existingOrder.integrationSessionId);
  }

  let quote = await loadOwnedQuote(input.quoteId, businessId, input.customerKey);
  if (quote.expiresAt <= new Date()) {
    throw new AppError(
      409,
      'QUOTE_EXPIRED',
      'This quote has expired. Create a new quote and obtain fresh customer confirmation.',
    );
  }
  const callbackUrl = resolveWhatsAppCallbackUrl();
  gateway.assertConfigured(requestId);
  quote = await bindQuoteToCheckout(quote, checkoutKeyHash, businessId, input.customerKey);

  const options = checkoutOptions(
    String(quote._id),
    quote.integrationSessionId,
    businessId,
    input.customerKey,
    callbackUrl,
  );
  options.validateDraft = async (draft, mongoSession) => {
    const current = await IntegrationCheckoutQuoteModel.findOne({
      _id: quote._id,
      businessId,
      customerKey: input.customerKey,
      checkoutKeyHash,
      integrationSessionId: quote.integrationSessionId,
      expiresAt: { $gt: new Date() },
    }).select('+checkoutKeyHash').session(mongoSession);
    if (!current) {
      throw new AppError(
        409,
        'QUOTE_EXPIRED',
        'This quote has expired. Create a new quote and obtain fresh customer confirmation.',
      );
    }
    assertQuoteMatchesDraft(current, draft);
  };
  options.afterOrderCreated = async (orderId: unknown, mongoSession: ClientSession) => {
    const update = await IntegrationCheckoutQuoteModel.updateOne(
      { _id: quote._id, checkoutKeyHash, integrationSessionId: quote.integrationSessionId },
      { $set: { consumedByOrderId: orderId } },
      { session: mongoSession },
    );
    if (update.matchedCount !== 1) throw new AppError(409, 'QUOTE_BINDING_LOST', 'The quote binding changed.');
  };

  const session = await createCheckoutSession(
    checkoutInputFromQuote(quote),
    idempotencyKey,
    gateway,
    requestId,
    options,
  );
  return mapToIntegrationSession(session, quote.integrationSessionId);
}

function checkoutInputFromQuote(quote: any) {
  return {
    customer: {
      fullName: quote.customer.fullName,
      email: quote.customer.email,
      whatsappNumber: quote.customer.whatsappNumber,
      deliveryAddress: quote.customer.deliveryAddress,
      whatsappConsent: true as const,
    },
    orderNotes: quote.orderNotes ?? '',
    items: quote.items.map((item: any) => ({ productId: item.productId, quantity: item.quantity })),
  };
}

function checkoutInputFromOrder(order: any) {
  return {
    customer: {
      fullName: order.customer.fullName,
      email: order.customer.email,
      whatsappNumber: order.customer.whatsappNumber,
      deliveryAddress: order.customer.deliveryAddress,
      whatsappConsent: true as const,
    },
    orderNotes: order.orderNotes ?? '',
    items: order.items.map((item: any) => ({ productId: String(item.product), quantity: item.quantity })),
  };
}

function checkoutOptions(
  quoteId: string,
  sessionId: string,
  businessId: string,
  customerKey: string,
  callbackUrl?: string,
): CreateCheckoutSessionOptions {
  return {
    source: 'whatsapp',
    ...(callbackUrl ? { callbackUrl } : {}),
    integrationSessionId: sessionId,
    integrationBusinessId: businessId,
    integrationCustomerKey: customerKey,
    integrationQuoteId: quoteId,
    validateExisting: (order) => assertOrderBinding(order, quoteId, businessId, customerKey),
  };
}

export interface IntegrationCheckoutStatus {
  sessionId: string;
  orderNumber: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  deliveryFeeStatus: string;
  amountPesewas: number;
  currency: 'GHS';
  deliveryFee: 'arranged_separately';
  receipt?: { number?: string; url?: string };
}

export async function getIntegrationCheckoutStatus(
  sessionId: string,
  customerKey: string,
): Promise<IntegrationCheckoutStatus> {
  assertCheckoutEnabled();
  const businessId = resolveBusinessId();
  const order = await OrderModel.findOne({ integrationSessionId: sessionId, integrationBusinessId: businessId })
    .select('+idempotencyKeyHash')
    .lean();
  if (!order) throw new AppError(404, 'SESSION_NOT_FOUND', 'The requested checkout session does not exist.');
  if (order.integrationCustomerKey !== customerKey) {
    throw new AppError(403, 'SESSION_ACCESS_DENIED', 'This checkout session is not available to the specified customer.');
  }
  const status = await getCheckoutStatusByHash(order.idempotencyKeyHash);
  return {
    sessionId,
    orderNumber: status.orderNumber,
    paymentStatus: status.paymentStatus,
    fulfillmentStatus: status.fulfillmentStatus,
    deliveryFeeStatus: status.deliveryFeeStatus,
    amountPesewas: status.amountPesewas,
    currency: 'GHS',
    deliveryFee: 'arranged_separately',
    ...(status.receipt ? { receipt: status.receipt } : {}),
  };
}

function mapToIntegrationSession(session: CheckoutSession, sessionId: string): IntegrationCheckoutSession {
  return {
    created: session.created,
    sessionId,
    orderNumber: session.orderNumber,
    amountPesewas: session.amountPesewas,
    currency: 'GHS',
    paymentStatus: session.paymentStatus,
    fulfillmentStatus: session.fulfillmentStatus,
    deliveryFee: 'arranged_separately',
    ...(session.payment?.authorizationUrl ? { paymentUrl: session.payment.authorizationUrl } : {}),
  };
}

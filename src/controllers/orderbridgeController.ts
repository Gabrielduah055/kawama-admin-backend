import type { RequestHandler } from 'express';
import {
  createIntegrationCheckoutSession,
  createIntegrationQuote,
  getIntegrationCheckoutStatus,
} from '../services/integration-checkout.service.js';
import type { PaystackGateway } from '../services/paystack.service.js';
import { issueReviewLinks } from '../services/review-links.service.js';
import {
  getOrderBridgeCatalogOverview,
  getOrderBridgePolicies,
  getOrderBridgeProduct,
  getOrderBridgeProductAvailability,
  searchOrderBridgeProducts,
} from '../services/orderbridge.service.js';
import {
  orderBridgeCatalogOverviewQuerySchema,
  orderBridgePoliciesQuerySchema,
  orderBridgeProductIdSchema,
  orderBridgeProductSearchSchema,
} from '../validation/orderbridge.schemas.js';
import {
  integrationCheckoutCreateSchema,
  integrationQuoteCreateSchema,
  integrationSessionIdSchema,
  integrationStatusQuerySchema,
} from '../validation/integration-checkout.schemas.js';
import { checkoutIdempotencyKeySchema } from '../validation/schemas.js';

export const getCatalogOverviewForOrderBridge: RequestHandler = async (request, response) => {
  const { limit } = orderBridgeCatalogOverviewQuerySchema.parse(request.query);
  response.status(200).json(await getOrderBridgeCatalogOverview(limit));
};

export const searchProductsForOrderBridge: RequestHandler = async (request, response) => {
  const input = orderBridgeProductSearchSchema.parse(request.query);
  response.status(200).json(await searchOrderBridgeProducts({
    ...(input.query ? { query: input.query } : {}),
    limit: input.limit,
    ...(input.minPrice !== undefined ? { minPrice: input.minPrice } : {}),
    ...(input.maxPrice !== undefined ? { maxPrice: input.maxPrice } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.available !== undefined ? { available: input.available } : {}),
    preferences: input.preference,
    sort: input.sort,
  }));
};

export const getProductForOrderBridge: RequestHandler = async (request, response) => {
  const productId = orderBridgeProductIdSchema.parse(request.params.productId);
  response.status(200).json(await getOrderBridgeProduct(productId));
};

export const getProductAvailabilityForOrderBridge: RequestHandler = async (request, response) => {
  const productId = orderBridgeProductIdSchema.parse(request.params.productId);
  response.status(200).json(await getOrderBridgeProductAvailability(productId));
};

export const getPoliciesForOrderBridge: RequestHandler = async (request, response) => {
  const { topic } = orderBridgePoliciesQuerySchema.parse(request.query);
  response.status(200).json(getOrderBridgePolicies(topic));
};

export const issueOrderReviewLinks: RequestHandler = async (request, response) => {
  response.status(200).json(await issueReviewLinks(String(request.params.orderId)));
};

export const createOrderBridgeCheckoutQuote: RequestHandler = async (request, response) => {
  const input = integrationQuoteCreateSchema.parse(request.body);
  const quote = await createIntegrationQuote(input);
  response.status(201).json({ message: 'Checkout quote created successfully', data: quote });
};

export const createOrderBridgeCheckoutSession = (gateway: PaystackGateway): RequestHandler =>
  async (request, response) => {
    const input = integrationCheckoutCreateSchema.parse(request.body);
    const idempotencyKey = checkoutIdempotencyKeySchema.parse(request.header('idempotency-key'));
    const session = await createIntegrationCheckoutSession(input, idempotencyKey, gateway, request.id);
    response.status(session.created ? 201 : 200).json({
      message: session.created ? 'Checkout initialized successfully' : 'Existing checkout returned successfully',
      data: session,
    });
  };

export const getOrderBridgeCheckoutStatus: RequestHandler = async (request, response) => {
  const sessionId = integrationSessionIdSchema.parse(request.params.sessionId);
  const { customerKey } = integrationStatusQuerySchema.parse(request.query);
  const status = await getIntegrationCheckoutStatus(sessionId, customerKey);
  response.status(200).json({ message: 'Checkout status fetched successfully', data: status });
};

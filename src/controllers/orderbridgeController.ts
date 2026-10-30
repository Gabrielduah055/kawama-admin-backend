import type { RequestHandler } from 'express';
import {
  getOrderBridgePolicies,
  getOrderBridgeProduct,
  getOrderBridgeProductAvailability,
  searchOrderBridgeProducts,
} from '../services/orderbridge.service.js';
import {
  orderBridgePoliciesQuerySchema,
  orderBridgeProductIdSchema,
  orderBridgeProductSearchSchema,
} from '../validation/orderbridge.schemas.js';

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

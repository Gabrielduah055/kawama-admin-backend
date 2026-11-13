import { Router } from 'express';
import {
  createOrderBridgeCheckoutQuote,
  createOrderBridgeCheckoutSession,
  getCatalogOverviewForOrderBridge,
  getOrderBridgeCheckoutStatus,
  getPoliciesForOrderBridge,
  getProductAvailabilityForOrderBridge,
  getProductForOrderBridge,
  issueOrderReviewLinks,
  searchProductsForOrderBridge,
} from '../controllers/orderbridgeController.js';
import type { PaystackGateway } from '../services/paystack.service.js';

export const createOrderBridgeRouter = (gateway: PaystackGateway): Router => {
  const router = Router();
  router.post('/checkout/quotes', createOrderBridgeCheckoutQuote);
  router.post('/checkout/sessions', createOrderBridgeCheckoutSession(gateway));
  router.get('/checkout/sessions/:sessionId/status', getOrderBridgeCheckoutStatus);
  router.post('/orders/:orderId/review-links', issueOrderReviewLinks);
  router.get('/catalog/overview', getCatalogOverviewForOrderBridge);
  router.get('/products/search', searchProductsForOrderBridge);
  router.get('/products/:productId/availability', getProductAvailabilityForOrderBridge);
  router.get('/products/:productId', getProductForOrderBridge);
  router.get('/policies', getPoliciesForOrderBridge);
  return router;
};

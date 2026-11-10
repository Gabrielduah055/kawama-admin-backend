import { Router } from 'express';
import {
  getCatalogOverviewForOrderBridge,
  getPoliciesForOrderBridge,
  getProductAvailabilityForOrderBridge,
  getProductForOrderBridge,
  issueOrderReviewLinks,
  searchProductsForOrderBridge,
} from '../controllers/orderbridgeController.js';

export const orderBridgeRouter = Router();
orderBridgeRouter.post('/orders/:orderId/review-links', issueOrderReviewLinks);
orderBridgeRouter.get('/catalog/overview', getCatalogOverviewForOrderBridge);
orderBridgeRouter.get('/products/search', searchProductsForOrderBridge);
orderBridgeRouter.get('/products/:productId/availability', getProductAvailabilityForOrderBridge);
orderBridgeRouter.get('/products/:productId', getProductForOrderBridge);
orderBridgeRouter.get('/policies', getPoliciesForOrderBridge);

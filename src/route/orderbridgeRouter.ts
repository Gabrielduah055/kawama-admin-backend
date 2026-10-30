import { Router } from 'express';
import {
  getPoliciesForOrderBridge,
  getProductAvailabilityForOrderBridge,
  getProductForOrderBridge,
  searchProductsForOrderBridge,
} from '../controllers/orderbridgeController.js';

export const orderBridgeRouter = Router();
orderBridgeRouter.get('/products/search', searchProductsForOrderBridge);
orderBridgeRouter.get('/products/:productId/availability', getProductAvailabilityForOrderBridge);
orderBridgeRouter.get('/products/:productId', getProductForOrderBridge);
orderBridgeRouter.get('/policies', getPoliciesForOrderBridge);

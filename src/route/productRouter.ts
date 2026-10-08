import { Router, type RequestHandler } from 'express';
import { getPublicCategories } from '../controllers/categoryController.js';
import {
  archiveProduct,
  createProduct,
  getPublicProductBySlug,
  getPublicProducts,
  updateProduct,
} from '../controllers/productController.js';

export const createProductRouter = (requireAdmin: RequestHandler): Router => {
  const router = Router();

  // Same route style used by slipper-api-updated.
  router.get('/categories', getPublicCategories);
  router.get('/', getPublicProducts);
  router.get('/:slug', getPublicProductBySlug);
  router.post('/', requireAdmin, createProduct);
  router.put('/:id', requireAdmin, updateProduct);
  router.delete('/:id', requireAdmin, archiveProduct);

  return router;
};

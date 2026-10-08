import { Router } from 'express';
import {
  archiveCategory,
  createCategory,
  getAllCategories,
  getCategoryById,
  restoreCategory,
  updateCategory,
  updateCategoryOrder,
} from '../controllers/categoryController.js';
import {
  archiveProduct,
  createProduct,
  getAllProducts,
  getProductById,
  restoreProduct,
  updateProduct,
} from '../controllers/productController.js';
import { archiveReview, getAllReviews, updateReviewStatus } from '../controllers/reviewController.js';
import { createUploadSignature, deleteUpload } from '../controllers/uploadController.js';
import type { MediaService } from '../services/cloudinary.service.js';

export const createAdminRouter = (mediaService: MediaService): Router => {
  const router = Router();

  router.get('/products', getAllProducts);
  router.post('/products', createProduct);
  router.get('/products/:id', getProductById);
  router.patch('/products/:id', updateProduct);
  router.delete('/products/:id', archiveProduct);
  router.post('/products/:id/restore', restoreProduct);

  router.get('/categories', getAllCategories);
  router.post('/categories', createCategory);
  router.patch('/categories/order', updateCategoryOrder);
  router.get('/categories/:id', getCategoryById);
  router.patch('/categories/:id', updateCategory);
  router.delete('/categories/:id', archiveCategory);
  router.post('/categories/:id/restore', restoreCategory);

  router.get('/reviews', getAllReviews);
  router.patch('/reviews/:id/status', updateReviewStatus);
  router.delete('/reviews/:id', archiveReview);

  router.post('/uploads/signature', createUploadSignature(mediaService));
  router.delete('/uploads', deleteUpload(mediaService));

  return router;
};

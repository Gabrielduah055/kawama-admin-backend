import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { getPublicCategories } from '../controllers/categoryController.js';
import { getPublicProductBySlug, getPublicProducts } from '../controllers/productController.js';
import { getApprovedReviews, submitReview } from '../controllers/reviewController.js';

const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (request, response) => response.status(429).json({
    error: {
      code: 'REVIEW_RATE_LIMIT',
      message: 'Please wait before submitting another review.',
      requestId: String(request.id),
    },
  }),
});

export const publicRouter = Router();
publicRouter.get('/categories', getPublicCategories);
publicRouter.get('/products', getPublicProducts);
publicRouter.get('/products/:productId/reviews', getApprovedReviews);
publicRouter.post('/products/:productId/reviews', reviewLimiter, submitReview);
publicRouter.get('/products/:slug', getPublicProductBySlug);

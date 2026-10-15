import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  createCheckoutSessionHandler,
  createPaystackWebhookHandler,
  getCheckoutStatusHandler,
} from '../controllers/checkoutController.js';
import type { PaystackGateway } from '../services/paystack.service.js';

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (request, response) => response.status(429).json({
    error: {
      code: 'CHECKOUT_RATE_LIMIT',
      message: 'Too many checkout attempts. Please wait before trying again.',
      requestId: String(request.id),
    },
  }),
});

export const createCheckoutRouter = (gateway: PaystackGateway): Router => {
  const router = Router();
  router.post('/sessions', checkoutLimiter, createCheckoutSessionHandler(gateway));
  router.get('/sessions/:checkoutToken', getCheckoutStatusHandler);
  return router;
};

export const createPaystackWebhookRouter = (gateway: PaystackGateway): Router => {
  const router = Router();
  router.post('/paystack', createPaystackWebhookHandler(gateway));
  return router;
};

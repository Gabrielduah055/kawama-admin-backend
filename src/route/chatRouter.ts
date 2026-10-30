import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createChatHandler, type ShoppingChatRunner } from '../controllers/chatController.js';

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: process.env.NODE_ENV === 'test' ? 10_000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (request, response) => response.status(429).json({
    error: {
      code: 'CHAT_RATE_LIMIT',
      message: 'Please wait before sending another chat message.',
      requestId: String(request.id),
    },
  }),
});

export function createChatRouter(runChat: ShoppingChatRunner): Router {
  const router = Router();
  router.post('/chat', chatLimiter, createChatHandler(runChat));
  return router;
}

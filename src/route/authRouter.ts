import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { loginAdmin } from '../controllers/authController.js';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (request, response) => response.status(429).json({
    error: {
      code: 'LOGIN_RATE_LIMIT',
      message: 'Too many login attempts. Please try again later.',
      requestId: String(request.id),
    },
  }),
});

export const authRouter = Router();
authRouter.post('/login', loginLimiter, loginAdmin);

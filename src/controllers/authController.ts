import type { RequestHandler } from 'express';
import { z } from 'zod';
import { authenticateAdmin } from '../services/auth.service.js';

const loginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(8).max(200),
});

export const loginAdmin: RequestHandler = async (request, response) => {
  const input = loginSchema.parse(request.body);
  const result = await authenticateAdmin(input.email, input.password);
  response.status(200).json({
    message: 'Administrator logged in successfully',
    data: { ...result, tokenType: 'Bearer' },
  });
};

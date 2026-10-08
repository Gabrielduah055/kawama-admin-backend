import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import type { AdminTokenVerifier } from '../services/auth.service.js';

export const createAdministratorAuthentication = (verifyToken: AdminTokenVerifier): RequestHandler =>
  async (request, _response, next) => {
    const authorization = request.header('authorization');
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
    if (!match?.[1]) {
      next(new AppError(401, 'ADMIN_TOKEN_REQUIRED', 'An administrator bearer token is required.'));
      return;
    }

    try {
      request.admin = await verifyToken(match[1]);
      next();
    } catch (error) {
      next(error);
    }
  };

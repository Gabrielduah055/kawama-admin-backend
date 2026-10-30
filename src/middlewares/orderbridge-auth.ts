import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function createOrderBridgeAuthentication(configuredApiKey: string | undefined): RequestHandler {
  return (request, _response, next) => {
    if (!configuredApiKey) {
      next(new AppError(
        503,
        'ORDERBRIDGE_INTEGRATION_NOT_CONFIGURED',
        'The OrderBridge integration is not configured.',
      ));
      return;
    }

    const authorization = request.header('authorization');
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
    if (!match?.[1]) {
      next(new AppError(401, 'ORDERBRIDGE_API_KEY_REQUIRED', 'A valid OrderBridge API key is required.'));
      return;
    }

    if (!timingSafeEqual(digest(match[1]), digest(configuredApiKey))) {
      next(new AppError(401, 'INVALID_ORDERBRIDGE_API_KEY', 'A valid OrderBridge API key is required.'));
      return;
    }
    next();
  };
}

import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../errors/AppError.js';
import { logger } from '../utils/logger.js';

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Route ${request.method} ${request.path} was not found`));
};

export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  let normalized: AppError;
  if (error instanceof AppError) {
    normalized = error;
  } else if (error instanceof ZodError) {
    normalized = new AppError(422, 'VALIDATION_ERROR', 'Request validation failed', error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })));
  } else if (error instanceof mongoose.Error.ValidationError) {
    normalized = new AppError(422, 'VALIDATION_ERROR', 'Request validation failed');
  } else if (error instanceof mongoose.Error.CastError) {
    normalized = new AppError(400, 'INVALID_IDENTIFIER', 'Request contains an invalid identifier');
  } else if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
    normalized = new AppError(409, 'DUPLICATE_RESOURCE', 'A resource with that unique value already exists');
  } else if (error instanceof SyntaxError && 'body' in error) {
    normalized = new AppError(400, 'MALFORMED_JSON', 'Request body contains malformed JSON');
  } else {
    normalized = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }

  if (normalized.status >= 500) {
    logger.error('request_failed', {
      code: normalized.code,
      method: request.method,
      path: request.path,
      requestId: String(response.locals.requestId),
    });
  }

  response.status(normalized.status).json({
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details !== undefined ? { details: normalized.details } : {}),
      requestId: String(response.locals.requestId),
    },
  });
};

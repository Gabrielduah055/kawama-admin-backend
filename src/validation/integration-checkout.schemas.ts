import { z } from 'zod';
import { objectIdSchema, checkoutCreateSchema } from './schemas.js';

/**
 * customerKey: A stable identifier for the end customer, supplied by the trusted
 * OrderBridge server on every checkout request. OrderBridge derives it from the
 * authenticated WhatsApp user session. It is sent as a required string field in
 * the JSON request body (for POST endpoints) and is used to bind quotes and
 * checkout sessions to a specific customer within the configured business scope.
 *
 * The same customerKey must be used consistently across quote creation, checkout
 * creation, and status queries to enforce ownership. The backend never exposes
 * the private checkoutToken through integration endpoints.
 */
export const customerKeySchema = z
  .string()
  .trim()
  .min(4)
  .max(200)
  .regex(/^[A-Za-z0-9._:@+-]+$/, 'Use letters, numbers, dots, underscores, colons, at-signs, plus signs, or hyphens only.');

/**
 * POST /checkout/quotes
 * Reuses the existing checkout validation for customer details and items.
 * Adds customerKey for integration binding.
 */
export const integrationQuoteCreateSchema = checkoutCreateSchema
  .safeExtend({
    customerKey: customerKeySchema,
  })
  .strict();

/**
 * POST /checkout/sessions
 * Creates or resumes a checkout from a saved quote.
 */
export const integrationCheckoutCreateSchema = z.object({
  quoteId: objectIdSchema,
  customerKey: customerKeySchema,
}).strict();

/**
 * GET /checkout/sessions/:sessionId/status
 * Path parameter for the integration session ID.
 */
export const integrationSessionIdSchema = z
  .string()
  .trim()
  .min(16)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dots, underscores, or hyphens only.');

/**
 * Query parameter for status endpoint customer binding.
 * customerKey is sent as a query parameter on GET requests.
 */
export const integrationStatusQuerySchema = z.object({
  customerKey: customerKeySchema,
}).strict();

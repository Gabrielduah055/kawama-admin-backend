import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/AppError.js';
import {
  createCheckoutSession,
  finalizeVerifiedPayment,
  getCheckoutStatus,
} from '../services/checkout.service.js';
import type { PaystackGateway } from '../services/paystack.service.js';
import { logger } from '../utils/logger.js';
import {
  checkoutCreateSchema,
  checkoutIdempotencyKeySchema,
  checkoutTokenSchema,
} from '../validation/schemas.js';

const paystackEventSchema = z.object({
  event: z.string(),
  data: z.object({ reference: z.string().min(1) }).passthrough(),
}).passthrough();

export const createCheckoutSessionHandler = (gateway: PaystackGateway): RequestHandler =>
  async (request, response) => {
    const input = checkoutCreateSchema.parse(request.body);
    const checkoutToken = checkoutIdempotencyKeySchema.parse(request.header('idempotency-key'));
    const session = await createCheckoutSession(input, checkoutToken, gateway);
    response.status(session.created ? 201 : 200).json({
      message: session.created ? 'Checkout initialized successfully' : 'Existing checkout returned successfully',
      data: session,
    });
  };

export const getCheckoutStatusHandler: RequestHandler = async (request, response) => {
  const checkoutToken = checkoutTokenSchema.parse(request.params.checkoutToken);
  const status = await getCheckoutStatus(checkoutToken);
  response.status(200).json({ message: 'Checkout status fetched successfully', data: status });
};

export const createPaystackWebhookHandler = (gateway: PaystackGateway): RequestHandler =>
  async (request, response) => {
    const signature = request.header('x-paystack-signature');
    if (!signature || !request.rawBody || !gateway.verifyWebhookSignature(request.rawBody, signature)) {
      throw new AppError(401, 'INVALID_PAYSTACK_SIGNATURE', 'The Paystack webhook signature is invalid.');
    }

    const event = paystackEventSchema.parse(request.body);
    if (event.event !== 'charge.success') {
      response.status(200).json({ received: true });
      return;
    }

    const verification = await gateway.verifyTransaction(event.data.reference);
    const result = await finalizeVerifiedPayment(event.data.reference, verification);
    logger.info('paystack_webhook_processed', { reference: event.data.reference, result });
    response.status(200).json({ received: true });
  };

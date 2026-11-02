import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { getEnvironment, type Environment } from '../config/environment.js';
import { OrderBridgePaidOrderOutboxModel } from '../models/OrderBridgePaidOrderOutboxSchema.js';
import { logger } from '../utils/logger.js';

const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_LEASE_MS = 30_000;
const WORKER_POLL_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_BACKOFF_MS = 15 * 60_000;

interface PaidOrderEventPayload {
  type: 'order.paid';
  eventId: string;
  occurredAt: Date;
  order: {
    externalOrderId: string;
    orderNumber: string;
    paymentReference: string;
    paidAt: Date;
    currency: 'GHS';
    productPaymentTotalPesewas: number;
    items: Array<{
      externalProductId: string;
      name: string;
      quantity: number;
      unitPricePesewas: number;
      lineTotalPesewas: number;
    }>;
    customer: {
      name: string;
      phone: string;
      email: string;
      whatsappConsent: boolean;
    };
    delivery: {
      recipientName: string;
      recipientPhone: string;
      addressLine1: string;
      addressLine2?: string;
      instructions?: string;
      chargeStatus: 'to_be_arranged';
    };
  };
}

interface PaidOrderEventsConfiguration {
  businessId: string;
  endpoint: URL;
  integrationKey: string;
}

interface DeliveryOutcome {
  delivered: boolean;
  retryable: boolean;
  errorCode?: string;
  httpStatus?: number;
}

export interface OrderBridgePaidOrderEventsWorker {
  stop(): Promise<void>;
}

const acknowledgementSchema = z.object({
  success: z.literal(true),
  message: z.enum(['Commerce event received', 'Commerce event already received']),
  data: z.object({
    eventId: z.string().trim().min(1).max(160),
    status: z.literal('received'),
  }).strict(),
}).strict();

function resolveConfiguration(environment: Environment): PaidOrderEventsConfiguration | undefined {
  if (!environment.ORDERBRIDGE_PAID_ORDER_EVENTS_ENABLED) return undefined;
  if (!environment.ORDERBRIDGE_BASE_URL) {
    throw new Error('Missing required environment variable: ORDERBRIDGE_BASE_URL');
  }
  if (!environment.ORDERBRIDGE_BUSINESS_ID) {
    throw new Error('Missing required environment variable: ORDERBRIDGE_BUSINESS_ID');
  }
  if (!environment.ORDERBRIDGE_WEBSITE_INTEGRATION_KEY) {
    throw new Error('Missing required environment variable: ORDERBRIDGE_WEBSITE_INTEGRATION_KEY');
  }

  const baseUrl = new URL(environment.ORDERBRIDGE_BASE_URL);
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
    throw new Error('ORDERBRIDGE_BASE_URL must be an HTTPS URL without embedded credentials');
  }
  const businessId = environment.ORDERBRIDGE_BUSINESS_ID.toLowerCase();

  return {
    businessId,
    endpoint: new URL(
      `/api/integrations/commerce/${encodeURIComponent(businessId)}/events`,
      baseUrl.origin,
    ),
    integrationKey: environment.ORDERBRIDGE_WEBSITE_INTEGRATION_KEY,
  };
}

export function validateOrderBridgePaidOrderEventsConfiguration(): void {
  resolveConfiguration(getEnvironment());
}

function splitDeliveryAddress(address: string): { addressLine1: string; addressLine2?: string } {
  const normalized = address.trim();
  if (normalized.length <= 300) return { addressLine1: normalized };
  let splitAt = normalized.lastIndexOf(' ', 300);
  const minimumSplit = normalized.length - 300;
  if (splitAt < Math.max(1, minimumSplit)) {
    splitAt = 300;
    const precedingCodeUnit = normalized.charCodeAt(splitAt - 1);
    if (precedingCodeUnit >= 0xD800 && precedingCodeUnit <= 0xDBFF) splitAt -= 1;
  }
  return {
    addressLine1: normalized.slice(0, splitAt).trim(),
    addressLine2: normalized.slice(splitAt).trim(),
  };
}

export function buildPaidOrderOutboxRecord(order: any, businessId: string, now = new Date()) {
  const eventId = `evt_${randomUUID()}`;
  const address = splitDeliveryAddress(order.customer.deliveryAddress);
  const payload: PaidOrderEventPayload = {
    type: 'order.paid',
    eventId,
    occurredAt: now,
    order: {
      externalOrderId: String(order._id),
      orderNumber: order.orderNumber,
      paymentReference: order.paymentReference,
      paidAt: order.paidAt,
      currency: order.currency,
      productPaymentTotalPesewas: order.productPaymentTotalPesewas,
      items: order.items.map((item: any) => ({
        externalProductId: String(item.product),
        name: item.name,
        quantity: item.quantity,
        unitPricePesewas: item.unitPricePesewas,
        lineTotalPesewas: item.lineTotalPesewas,
      })),
      customer: {
        name: order.customer.fullName,
        phone: order.customer.whatsappNumber,
        email: order.customer.email,
        whatsappConsent: order.customer.whatsappConsent,
      },
      delivery: {
        recipientName: order.customer.fullName,
        recipientPhone: order.customer.whatsappNumber,
        ...address,
        ...(order.orderNotes ? { instructions: order.orderNotes } : {}),
        chargeStatus: 'to_be_arranged',
      },
    },
  };

  return {
    destinationBusinessId: businessId,
    eventId,
    occurredAt: now,
    payload,
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: now,
    createdAt: now,
  };
}

export async function createPaidOrderOutboxEvent(order: any, session: ClientSession): Promise<void> {
  const configuration = resolveConfiguration(getEnvironment());
  if (!configuration) return;
  const record = buildPaidOrderOutboxRecord(order, configuration.businessId);
  await OrderBridgePaidOrderOutboxModel.create([record], { session });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    throw new Error('RESPONSE_TOO_LARGE');
  }
  if (!response.body) throw new Error('INVALID_ACKNOWLEDGEMENT');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('INVALID_ACKNOWLEDGEMENT');
  }
}

async function deliverEvent(
  outboxEvent: any,
  configuration: PaidOrderEventsConfiguration,
  stopSignal: AbortSignal,
): Promise<DeliveryOutcome> {
  let response: Response;
  try {
    response = await fetch(configuration.endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${configuration.integrationKey}`,
      },
      body: JSON.stringify(outboxEvent.payload),
      redirect: 'manual',
      signal: AbortSignal.any([stopSignal, AbortSignal.timeout(DELIVERY_TIMEOUT_MS)]),
    });
  } catch {
    return {
      delivered: false,
      retryable: true,
      errorCode: stopSignal.aborted ? 'WORKER_STOPPED' : 'NETWORK_OR_TIMEOUT',
    };
  }

  if (response.status !== 200 && response.status !== 201) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    const retryable = response.status === 408
      || response.status === 425
      || response.status === 429
      || response.status >= 500;
    return {
      delivered: false,
      retryable,
      errorCode: response.status === 409 ? 'EVENT_CONFLICT' : 'UNEXPECTED_HTTP_STATUS',
      httpStatus: response.status,
    };
  }

  try {
    const acknowledgement = acknowledgementSchema.safeParse(await readBoundedJson(response));
    const expectedMessage = response.status === 201
      ? 'Commerce event received'
      : 'Commerce event already received';
    if (
      !acknowledgement.success
      || acknowledgement.data.data.eventId !== outboxEvent.eventId
      || acknowledgement.data.message !== expectedMessage
    ) {
      return {
        delivered: false,
        retryable: false,
        errorCode: acknowledgement.success ? 'ACKNOWLEDGEMENT_EVENT_MISMATCH' : 'INVALID_ACKNOWLEDGEMENT',
        httpStatus: response.status,
      };
    }
    return { delivered: true, retryable: false, httpStatus: response.status };
  } catch (error) {
    return {
      delivered: false,
      retryable: false,
      errorCode: error instanceof Error && error.message === 'RESPONSE_TOO_LARGE'
        ? 'RESPONSE_TOO_LARGE'
        : 'INVALID_ACKNOWLEDGEMENT',
      httpStatus: response.status,
    };
  }
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(MAX_BACKOFF_MS, 5_000 * (2 ** Math.min(Math.max(attemptCount - 1, 0), 8)));
}

async function claimNextEvent(businessId: string, now = new Date()): Promise<any | null> {
  const leaseId = randomUUID();
  return OrderBridgePaidOrderOutboxModel.findOneAndUpdate(
    {
      destinationBusinessId: businessId,
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'delivering', leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'delivering',
        leaseId,
        leaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
        lastAttemptAt: now,
      },
      $inc: { attemptCount: 1 },
    },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' },
  ).select('+leaseId');
}

async function recordDeliveryOutcome(outboxEvent: any, outcome: DeliveryOutcome): Promise<void> {
  const now = new Date();
  const ownership = { _id: outboxEvent._id, status: 'delivering', leaseId: outboxEvent.leaseId };
  if (outcome.delivered) {
    await OrderBridgePaidOrderOutboxModel.updateOne(
      ownership,
      {
        $set: { status: 'delivered', deliveredAt: now },
        $unset: {
          leaseId: 1,
          leaseExpiresAt: 1,
          lastErrorAt: 1,
          lastErrorCode: 1,
          lastHttpStatus: 1,
        },
      },
    );
    return;
  }

  await OrderBridgePaidOrderOutboxModel.updateOne(
    ownership,
    {
      $set: {
        status: outcome.retryable ? 'pending' : 'failed',
        lastErrorAt: now,
        lastErrorCode: outcome.errorCode ?? 'DELIVERY_FAILED',
        ...(outcome.httpStatus ? { lastHttpStatus: outcome.httpStatus } : {}),
        ...(outcome.retryable
          ? { nextAttemptAt: new Date(now.getTime() + retryDelayMs(outboxEvent.attemptCount)) }
          : {}),
      },
      $unset: {
        leaseId: 1,
        leaseExpiresAt: 1,
        ...(!outcome.httpStatus ? { lastHttpStatus: 1 } : {}),
      },
    },
  );
}

export function startOrderBridgePaidOrderEventsWorker(): OrderBridgePaidOrderEventsWorker {
  const configuration = resolveConfiguration(getEnvironment());
  if (!configuration) return { stop: async () => undefined };

  let stopped = false;
  let activeAbortController: AbortController | undefined;
  let wakeWorker: (() => void) | undefined;

  const waitForWork = async (): Promise<void> => {
    if (stopped) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WORKER_POLL_MS);
      timer.unref();
      wakeWorker = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wakeWorker = undefined;
  };

  const run = async (): Promise<void> => {
    while (!stopped) {
      let outboxEvent: any | null;
      try {
        outboxEvent = await claimNextEvent(configuration.businessId);
      } catch (error) {
        logger.error('orderbridge_paid_order_worker_claim_failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        await waitForWork();
        continue;
      }
      if (!outboxEvent) {
        await waitForWork();
        continue;
      }
      if (stopped) {
        try {
          await recordDeliveryOutcome(outboxEvent, {
            delivered: false,
            retryable: true,
            errorCode: 'WORKER_STOPPED',
          });
        } catch (error) {
          logger.error('orderbridge_paid_order_worker_update_failed', {
            eventId: outboxEvent.eventId,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        }
        break;
      }

      activeAbortController = new AbortController();
      try {
        const outcome = await deliverEvent(outboxEvent, configuration, activeAbortController.signal);
        await recordDeliveryOutcome(outboxEvent, outcome);
        if (!outcome.delivered) {
          logger.error('orderbridge_paid_order_delivery_failed', {
            eventId: outboxEvent.eventId,
            errorCode: outcome.errorCode,
            retryable: outcome.retryable,
            httpStatus: outcome.httpStatus,
          });
        }
      } catch (error) {
        logger.error('orderbridge_paid_order_worker_update_failed', {
          eventId: outboxEvent.eventId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      } finally {
        activeAbortController = undefined;
      }
    }
  };

  const runPromise = run();
  return {
    async stop() {
      stopped = true;
      wakeWorker?.();
      activeAbortController?.abort();
      await runPromise;
    },
  };
}

import { randomUUID } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { AppError } from '../errors/AppError.js';
import { hashCheckoutToken } from '../lib/orders.js';
import { CustomerModel } from '../models/CustomerSchema.js';
import { OrderModel } from '../models/OrderSchema.js';
import { PaymentAttemptModel } from '../models/PaymentAttemptSchema.js';
import { ProductModel } from '../models/ProductSchema.js';
import { buildPendingOrderDraft, type CheckoutInput } from './order.service.js';
import type { PaystackGateway, PaystackVerification } from './paystack.service.js';

const RESERVATION_MINUTES = 30;
const MAX_RECONCILIATION_ATTEMPTS = 3;
const RECONCILIATION_LEASE_MS = 15_000;
const PENDING_PROVIDER_STATUSES = new Set(['ongoing', 'pending', 'processing', 'queued']);
const UNSUCCESSFUL_PROVIDER_STATUSES = new Set(['abandoned', 'failed', 'reversed']);
const DEFINITIVE_INITIALIZATION_FAILURE_CODES = new Set([
  'PAYSTACK_NOT_CONFIGURED',
  'PAYSTACK_INVALID_CONFIGURATION',
  'PAYSTACK_AUTHENTICATION_FAILED',
  'PAYSTACK_INITIALIZATION_REJECTED',
  // Retained for compatibility with injected gateways that use the older code.
  'PAYSTACK_INITIALIZATION_FAILED',
]);

export interface CheckoutSession {
  created: boolean;
  checkoutToken: string;
  orderNumber: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  amountPesewas: number;
  currency: 'GHS';
  payment?: {
    reference: string;
    accessCode: string;
    authorizationUrl: string;
  };
}

export interface CheckoutStatus {
  orderNumber: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  deliveryFeeStatus: string;
  amountPesewas: number;
  currency: 'GHS';
  receipt?: { number?: string; url?: string };
}

async function releaseReservationInSession(order: any, session: ClientSession): Promise<void> {
  if (order.stockReservationStatus !== 'active') return;
  for (const item of order.items) {
    const released = await ProductModel.updateOne(
      { _id: item.product, reservedQuantity: { $gte: item.quantity } },
      { $inc: { reservedQuantity: -item.quantity } },
      { session },
    );
    if (released.modifiedCount !== 1) {
      throw new AppError(409, 'RESERVATION_RELEASE_FAILED', 'Reserved inventory could not be released safely.');
    }
  }
}

async function expireOrderReservation(orderId: unknown, now = new Date()): Promise<void> {
  await mongoose.connection.transaction(async (session) => {
    const order = await OrderModel.findById(orderId).session(session);
    if (
      !order ||
      order.paymentStatus !== 'pending' ||
      order.stockReservationStatus !== 'active' ||
      !order.stockReservationExpiresAt ||
      order.stockReservationExpiresAt > now
    ) return;

    await releaseReservationInSession(order, session);
    order.stockReservationStatus = 'released';
    order.paymentStatus = 'failed';
    order.fulfillmentStatus = 'cancelled';
    order.cancelledAt = now;
    await order.save({ session });
    await PaymentAttemptModel.updateMany(
      { order: order._id, status: { $in: ['initializing', 'initialized'] } },
      { status: 'failed', lastErrorCode: 'CHECKOUT_EXPIRED' },
      { session },
    );
  });
}

export async function releaseExpiredCheckoutReservations(now = new Date()): Promise<void> {
  const expired = await OrderModel.find({
    paymentStatus: 'pending',
    stockReservationStatus: 'active',
    stockReservationExpiresAt: { $lte: now },
  }).select('_id').limit(50).lean();
  for (const order of expired) await expireOrderReservation(order._id, now);
}

function checkoutSessionFromOrder(order: any, checkoutToken: string, attempt?: any): CheckoutSession {
  return {
    created: false,
    checkoutToken,
    orderNumber: order.orderNumber,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    amountPesewas: order.productPaymentTotalPesewas,
    currency: 'GHS',
    ...(attempt?.accessCode && attempt?.authorizationUrl
      ? {
          payment: {
            reference: attempt.reference,
            accessCode: attempt.accessCode,
            authorizationUrl: attempt.authorizationUrl,
          },
        }
      : {}),
  };
}

function uncertainInitializationError(): AppError {
  return new AppError(
    409,
    'CHECKOUT_INITIALIZATION_UNCERTAIN',
    'Paystack initialization could not be confirmed. Keep this checkout and retry with the same key.',
  );
}

interface OwnedRecoveryLease {
  attemptId: unknown;
  leaseId: string;
}

type ExhaustedRecoveryGuard =
  | OwnedRecoveryLease
  | { attemptId: unknown; staleBefore: Date; leaseId?: string }
  | { attemptId: unknown; completed: true };

function recoveryAttemptFilter(
  order: any,
  guard: ExhaustedRecoveryGuard,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    _id: guard.attemptId,
    order: order._id,
    reference: order.paymentReference,
  };
  if ('completed' in guard) {
    return {
      ...filter,
      status: 'uncertain',
      reconciliationAttempts: { $gte: MAX_RECONCILIATION_ATTEMPTS },
    };
  }
  if ('staleBefore' in guard) {
    return {
      ...filter,
      status: 'reconciling',
      reconciliationStartedAt: { $lte: guard.staleBefore },
      reconciliationLeaseId: guard.leaseId ?? { $exists: false },
    };
  }
  return {
    ...filter,
    status: 'reconciling',
    reconciliationLeaseId: guard.leaseId,
  };
}

async function cancelAfterInitializationFailure(
  orderId: unknown,
  errorCode: string,
  recoveryLease?: OwnedRecoveryLease,
): Promise<boolean> {
  let transitioned = false;
  await mongoose.connection.transaction(async (session) => {
    transitioned = false;
    const order = await OrderModel.findById(orderId).session(session);
    if (!order || order.paymentStatus !== 'pending') return;
    const attemptFilter = recoveryLease
      ? recoveryAttemptFilter(order, recoveryLease)
      : { order: order._id, reference: order.paymentReference };
    if (recoveryLease && !(await PaymentAttemptModel.exists(attemptFilter).session(session))) return;
    await releaseReservationInSession(order, session);
    order.stockReservationStatus = 'released';
    order.paymentStatus = 'failed';
    order.fulfillmentStatus = 'cancelled';
    order.cancelledAt = new Date();
    await order.save({ session });
    const attemptUpdate = await PaymentAttemptModel.updateOne(
      attemptFilter,
      {
        $set: { status: 'failed', lastErrorCode: errorCode },
        $unset: { reconciliationStartedAt: 1, reconciliationLeaseId: 1 },
      },
      { session },
    );
    if (recoveryLease && attemptUpdate.matchedCount !== 1) {
      throw new Error('Recovery lease changed during cancellation.');
    }
    transitioned = true;
  });
  return transitioned;
}

async function recordUncertainInitializationFailure(orderId: unknown, errorCode: string): Promise<void> {
  await PaymentAttemptModel.updateOne(
    { order: orderId, status: 'initializing' },
    { status: 'uncertain', lastErrorCode: errorCode },
  );
}

async function markRecoveryNeedsAttention(
  orderId: unknown,
  errorCode: string,
  guard: ExhaustedRecoveryGuard,
): Promise<boolean> {
  let transitioned = false;
  await mongoose.connection.transaction(async (session) => {
    transitioned = false;
    const order = await OrderModel.findById(orderId).session(session);
    if (!order || order.paymentStatus === 'paid' || order.paymentStatus === 'needs_attention') return;
    const attemptFilter = recoveryAttemptFilter(order, guard);
    if (!(await PaymentAttemptModel.exists(attemptFilter).session(session))) return;
    await releaseReservationInSession(order, session);
    order.stockReservationStatus = 'released';
    order.paymentStatus = 'needs_attention';
    order.fulfillmentStatus = 'needs_attention';
    await order.save({ session });
    const attemptUpdate = await PaymentAttemptModel.updateOne(
      attemptFilter,
      {
        $set: {
          status: 'needs_attention',
          lastErrorCode: errorCode,
          lastReconciledAt: new Date(),
        },
        $unset: { reconciliationStartedAt: 1, reconciliationLeaseId: 1 },
      },
      { session },
    );
    if (attemptUpdate.matchedCount !== 1) throw new Error('Recovery lease changed during escalation.');
    transitioned = true;
  });
  return transitioned;
}

async function loadCheckoutSession(orderId: unknown, checkoutToken: string): Promise<CheckoutSession> {
  const order = await OrderModel.findById(orderId).lean();
  if (!order) throw new AppError(404, 'CHECKOUT_NOT_FOUND', 'Checkout not found.');
  const attempt = await PaymentAttemptModel.findOne({ order: order._id })
    .sort({ createdAt: -1 })
    .select('+accessCode +authorizationUrl')
    .lean();
  return checkoutSessionFromOrder(order, checkoutToken, attempt);
}

async function reconcileUncertainInitialization(
  order: any,
  attempt: any,
  checkoutToken: string,
  gateway: PaystackGateway,
  requestId?: string,
): Promise<CheckoutSession> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - RECONCILIATION_LEASE_MS);
  const leaseId = randomUUID();
  const acquired = await PaymentAttemptModel.findOneAndUpdate(
    {
      _id: attempt._id,
      $and: [
        {
          $or: [
            { reconciliationAttempts: { $exists: false } },
            { reconciliationAttempts: { $lt: MAX_RECONCILIATION_ATTEMPTS } },
          ],
        },
        {
          $or: [
            { status: 'uncertain' },
            { status: 'reconciling', reconciliationStartedAt: { $lte: staleBefore } },
            { status: 'initializing', lastErrorCode: { $exists: true } },
            { status: 'initializing', updatedAt: { $lte: staleBefore } },
          ],
        },
      ],
    },
    {
      $set: { status: 'reconciling', reconciliationStartedAt: now, reconciliationLeaseId: leaseId },
      $inc: { reconciliationAttempts: 1 },
    },
    { returnDocument: 'after' },
  );

  if (!acquired) {
    const currentOrder = await OrderModel.findById(order._id).lean();
    const currentAttempt = await PaymentAttemptModel.findById(attempt._id)
      .select('+accessCode +authorizationUrl +reconciliationLeaseId')
      .lean();
    if (!currentOrder) throw new AppError(404, 'CHECKOUT_NOT_FOUND', 'Checkout not found.');
    if (
      currentOrder.paymentStatus === 'paid' ||
      currentOrder.paymentStatus === 'needs_attention' ||
      currentOrder.paymentStatus === 'failed'
    ) {
      return checkoutSessionFromOrder(currentOrder, checkoutToken, currentAttempt);
    }
    const reconciliationStartedAt = currentAttempt?.reconciliationStartedAt
      ? new Date(currentAttempt.reconciliationStartedAt)
      : undefined;
    if (
      currentAttempt?.status === 'reconciling' &&
      reconciliationStartedAt &&
      reconciliationStartedAt > staleBefore
    ) {
      throw uncertainInitializationError();
    }
    if ((currentAttempt?.reconciliationAttempts ?? 0) >= MAX_RECONCILIATION_ATTEMPTS) {
      const guard: ExhaustedRecoveryGuard | undefined = currentAttempt?.status === 'uncertain'
        ? { attemptId: currentAttempt._id, completed: true }
        : currentAttempt?.status === 'reconciling' && reconciliationStartedAt
          ? {
              attemptId: currentAttempt._id,
              staleBefore,
              ...(typeof currentAttempt.reconciliationLeaseId === 'string'
                ? { leaseId: currentAttempt.reconciliationLeaseId }
                : {}),
            }
          : undefined;
      if (guard) {
        await markRecoveryNeedsAttention(
          order._id,
          currentAttempt?.lastErrorCode ?? 'PAYSTACK_RECOVERY_EXHAUSTED',
          guard,
        );
      }
      const current = await loadCheckoutSession(order._id, checkoutToken);
      if (['paid', 'needs_attention', 'failed'].includes(current.paymentStatus)) return current;
    }
    throw uncertainInitializationError();
  }

  const recoveryLease: OwnedRecoveryLease = { attemptId: acquired._id, leaseId };

  let verification: PaystackVerification;
  try {
    verification = await gateway.verifyTransaction(order.paymentReference, requestId);
  } catch (error) {
    const errorCode = error instanceof AppError ? error.code : 'PAYSTACK_VERIFICATION_UNAVAILABLE';
    if (acquired.reconciliationAttempts >= MAX_RECONCILIATION_ATTEMPTS) {
      await markRecoveryNeedsAttention(order._id, errorCode, recoveryLease);
    } else {
      await PaymentAttemptModel.updateOne(
        recoveryAttemptFilter(order, recoveryLease),
        {
          $set: { status: 'uncertain', lastErrorCode: errorCode, lastReconciledAt: new Date() },
          $unset: { reconciliationStartedAt: 1, reconciliationLeaseId: 1 },
        },
      );
    }
    const current = await loadCheckoutSession(order._id, checkoutToken);
    if (['paid', 'needs_attention', 'failed'].includes(current.paymentStatus)) return current;
    throw uncertainInitializationError();
  }

  const providerStatus = verification.status.toLowerCase();
  if (!verificationIdentityMatches(order, verification)) {
    await markPaymentNeedsAttention(order._id, verification, 'PAYMENT_VERIFICATION_MISMATCH', recoveryLease);
    const current = await loadCheckoutSession(order._id, checkoutToken);
    if (['paid', 'needs_attention', 'failed'].includes(current.paymentStatus)) return current;
    throw uncertainInitializationError();
  }
  if (providerStatus === 'success') {
    await finalizeVerifiedPayment(order.paymentReference, verification);
    return loadCheckoutSession(order._id, checkoutToken);
  }
  if (UNSUCCESSFUL_PROVIDER_STATUSES.has(providerStatus)) {
    const cancelled = await cancelAfterInitializationFailure(
      order._id,
      `PAYSTACK_PAYMENT_${providerStatus.toUpperCase()}`,
      recoveryLease,
    );
    const current = await loadCheckoutSession(order._id, checkoutToken);
    if (current.paymentStatus === 'paid' || current.paymentStatus === 'needs_attention') return current;
    if (!cancelled && current.paymentStatus !== 'failed') throw uncertainInitializationError();
    throw new AppError(
      409,
      'CHECKOUT_INITIALIZATION_FAILED',
      'Paystack confirmed that this payment cannot continue. Start a new checkout.',
    );
  }
  if (PENDING_PROVIDER_STATUSES.has(providerStatus)) {
    if (acquired.reconciliationAttempts >= MAX_RECONCILIATION_ATTEMPTS) {
      await markPaymentNeedsAttention(
        order._id,
        verification,
        'PAYSTACK_RECOVERY_EXHAUSTED',
        recoveryLease,
      );
    } else {
      await PaymentAttemptModel.updateOne(
        recoveryAttemptFilter(order, recoveryLease),
        {
          $set: {
            status: 'uncertain',
            providerStatus,
            providerTransactionId: verification.transactionId,
            verifiedAt: new Date(),
            lastReconciledAt: new Date(),
            lastErrorCode: 'PAYSTACK_PAYMENT_PENDING',
          },
          $unset: { reconciliationStartedAt: 1, reconciliationLeaseId: 1 },
        },
      );
    }
    const current = await loadCheckoutSession(order._id, checkoutToken);
    if (['paid', 'needs_attention', 'failed'].includes(current.paymentStatus)) return current;
    throw uncertainInitializationError();
  }

  await markPaymentNeedsAttention(order._id, verification, 'PAYSTACK_UNKNOWN_PAYMENT_STATUS', recoveryLease);
  const current = await loadCheckoutSession(order._id, checkoutToken);
  if (['paid', 'needs_attention', 'failed'].includes(current.paymentStatus)) return current;
  throw uncertainInitializationError();
}

async function existingCheckoutSession(
  order: any,
  checkoutToken: string,
  gateway: PaystackGateway,
  requestId?: string,
): Promise<CheckoutSession> {
  const attempt = await PaymentAttemptModel.findOne({ order: order._id })
    .sort({ createdAt: -1 })
    .select('+accessCode +authorizationUrl')
    .lean();

  if (order.paymentStatus === 'failed' || order.fulfillmentStatus === 'cancelled') {
    throw new AppError(409, 'CHECKOUT_EXPIRED', 'This checkout can no longer be paid. Start a new checkout.');
  }
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'needs_attention') {
    return checkoutSessionFromOrder(order, checkoutToken, attempt);
  }
  if (attempt?.status === 'initializing' && !attempt.lastErrorCode) {
    const updatedAt = attempt.updatedAt instanceof Date ? attempt.updatedAt : new Date(attempt.updatedAt);
    if (updatedAt.getTime() > Date.now() - RECONCILIATION_LEASE_MS) {
      throw new AppError(409, 'CHECKOUT_INITIALIZING', 'This checkout is still being initialized. Please try again shortly.');
    }
  }
  if (attempt && ['initializing', 'uncertain', 'reconciling'].includes(attempt.status)) {
    return reconcileUncertainInitialization(order, attempt, checkoutToken, gateway, requestId);
  }
  if (attempt?.status === 'failed') {
    throw new AppError(409, 'CHECKOUT_INITIALIZATION_FAILED', 'This checkout could not be initialized. Start a new checkout.');
  }

  return checkoutSessionFromOrder(order, checkoutToken, attempt);
}

function duplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

export async function createCheckoutSession(
  input: CheckoutInput,
  checkoutToken: string,
  gateway: PaystackGateway,
  requestId?: string,
): Promise<CheckoutSession> {
  await releaseExpiredCheckoutReservations();
  const idempotencyKeyHash = hashCheckoutToken(checkoutToken);
  const existing = await OrderModel.findOne({ idempotencyKeyHash }).lean();
  if (existing) return existingCheckoutSession(existing, checkoutToken, gateway, requestId);
  // This preflight must run before any new order, payment attempt, or stock reservation is created.
  // Existing idempotent sessions remain recoverable if configuration changes later.
  gateway.assertConfigured(requestId);

  let order: any;
  let attempt: any;
  try {
    await mongoose.connection.transaction(async (session) => {
      const draft = await buildPendingOrderDraft(input, session);
      for (const item of draft.items) {
        const reserved = await ProductModel.updateOne(
          {
            _id: item.product,
            status: 'active',
            $expr: {
              $gte: [
                { $subtract: ['$stockQuantity', { $ifNull: ['$reservedQuantity', 0] }] },
                item.quantity,
              ],
            },
          },
          { $inc: { reservedQuantity: item.quantity } },
          { session },
        );
        if (reserved.modifiedCount !== 1) {
          throw new AppError(409, 'INSUFFICIENT_STOCK', 'One or more products no longer have enough stock.');
        }
      }

      const expiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60_000);
      [order] = await OrderModel.create(
        [{
          ...draft,
          idempotencyKeyHash,
          paymentReference: draft.orderNumber,
          stockReservationStatus: 'active',
          stockReservationExpiresAt: expiresAt,
        }],
        { session },
      );
      [attempt] = await PaymentAttemptModel.create(
        [{
          order: order._id,
          reference: draft.orderNumber,
          amountPesewas: draft.productPaymentTotalPesewas,
          currency: 'GHS',
          status: 'initializing',
        }],
        { session },
      );
    });
  } catch (error) {
    if (duplicateKeyError(error)) {
      const duplicate = await OrderModel.findOne({ idempotencyKeyHash }).lean();
      if (duplicate) return existingCheckoutSession(duplicate, checkoutToken, gateway, requestId);
    }
    throw error;
  }

  if (!order || !attempt) throw new AppError(500, 'CHECKOUT_CREATION_FAILED', 'The checkout could not be created.');

  let initialized;
  try {
    initialized = await gateway.initializeTransaction({
      email: order.customer.email,
      amountPesewas: order.productPaymentTotalPesewas,
      currency: 'GHS',
      reference: order.paymentReference,
      metadata: { order_id: String(order._id), order_number: order.orderNumber, source: 'kawama_storefront' },
      ...(requestId ? { requestId } : {}),
    });
  } catch (error) {
    const errorCode = error instanceof AppError ? error.code : 'PAYSTACK_INITIALIZATION_FAILED';
    if (error instanceof AppError && DEFINITIVE_INITIALIZATION_FAILURE_CODES.has(error.code)) {
      await cancelAfterInitializationFailure(order._id, errorCode);
    } else {
      // A request may have reached Paystack even if its response was lost or malformed.
      // Preserve this order/reference and its reservation; an idempotent replay will not
      // create a second attempt, and normal expiry will eventually release the stock.
      await recordUncertainInitializationFailure(order._id, errorCode);
    }
    if (!(error instanceof AppError) || !DEFINITIVE_INITIALIZATION_FAILURE_CODES.has(error.code)) {
      throw uncertainInitializationError();
    }
    throw error;
  }

  await PaymentAttemptModel.updateOne(
    { _id: attempt._id, status: 'initializing' },
    {
      status: 'initialized',
      accessCode: initialized.accessCode,
      authorizationUrl: initialized.authorizationUrl,
      initializedAt: new Date(),
    },
  );

  return {
    created: true,
    checkoutToken,
    orderNumber: order.orderNumber,
    paymentStatus: 'pending',
    fulfillmentStatus: 'awaiting_payment',
    amountPesewas: order.productPaymentTotalPesewas,
    currency: 'GHS',
    payment: initialized,
  };
}

export async function getCheckoutStatus(checkoutToken: string): Promise<CheckoutStatus> {
  const idempotencyKeyHash = hashCheckoutToken(checkoutToken);
  let order = await OrderModel.findOne({ idempotencyKeyHash }).lean();
  if (!order) throw new AppError(404, 'CHECKOUT_NOT_FOUND', 'Checkout not found.');

  if (
    order.paymentStatus === 'pending' &&
    order.stockReservationStatus === 'active' &&
    order.stockReservationExpiresAt &&
    order.stockReservationExpiresAt <= new Date()
  ) {
    await expireOrderReservation(order._id);
    order = await OrderModel.findById(order._id).lean();
  }
  if (!order) throw new AppError(404, 'CHECKOUT_NOT_FOUND', 'Checkout not found.');

  return {
    orderNumber: order.orderNumber,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    deliveryFeeStatus: order.deliveryFeeStatus,
    amountPesewas: order.productPaymentTotalPesewas,
    currency: 'GHS',
    ...(order.receipt
      ? {
          receipt: {
            ...(order.receipt.number ? { number: order.receipt.number } : {}),
            ...(order.receipt.url ? { url: order.receipt.url } : {}),
          },
        }
      : {}),
  };
}

function verificationIdentityMatches(order: any, verification: PaystackVerification): boolean {
  return verification.reference === order.paymentReference &&
    verification.amountPesewas === order.productPaymentTotalPesewas &&
    verification.currency.toUpperCase() === order.currency &&
    (!verification.customerEmail || verification.customerEmail === order.customer.email.toLowerCase());
}

function verificationMatches(order: any, verification: PaystackVerification): boolean {
  return verification.status.toLowerCase() === 'success' && verificationIdentityMatches(order, verification);
}

async function markPaymentNeedsAttention(
  orderId: unknown,
  verification: PaystackVerification,
  errorCode: string,
  recoveryLease?: OwnedRecoveryLease,
): Promise<boolean> {
  let transitioned = false;
  await mongoose.connection.transaction(async (session) => {
    transitioned = false;
    const order = await OrderModel.findById(orderId).session(session);
    if (!order || order.paymentStatus === 'paid') return;
    const attemptFilter = recoveryLease
      ? recoveryAttemptFilter(order, recoveryLease)
      : { order: order._id, reference: order.paymentReference };
    if (recoveryLease && !(await PaymentAttemptModel.exists(attemptFilter).session(session))) return;
    await releaseReservationInSession(order, session);
    order.stockReservationStatus = 'released';
    order.paymentStatus = 'needs_attention';
    order.fulfillmentStatus = 'needs_attention';
    order.paystackTransactionId = verification.transactionId;
    order.paymentVerifiedAt = new Date();
    await order.save({ session });
    const attemptUpdate = await PaymentAttemptModel.updateOne(
      attemptFilter,
      {
        $set: {
          status: 'needs_attention',
          providerStatus: verification.status,
          providerTransactionId: verification.transactionId,
          verifiedAt: new Date(),
          lastErrorCode: errorCode,
        },
        $unset: { reconciliationStartedAt: 1, reconciliationLeaseId: 1 },
      },
      { session },
    );
    if (recoveryLease && attemptUpdate.matchedCount !== 1) {
      throw new Error('Recovery lease changed during payment review.');
    }
    transitioned = true;
  });
  return transitioned;
}

export type PaymentFinalizationResult = 'paid' | 'already_paid' | 'needs_attention' | 'unknown_order';

export async function finalizeVerifiedPayment(
  reference: string,
  verification: PaystackVerification,
): Promise<PaymentFinalizationResult> {
  const initialOrder = await OrderModel.findOne({ paymentReference: reference });
  if (!initialOrder) return 'unknown_order';
  if (initialOrder.paymentStatus === 'paid') return 'already_paid';
  if (!verificationMatches(initialOrder, verification)) {
    await markPaymentNeedsAttention(initialOrder._id, verification, 'PAYMENT_VERIFICATION_MISMATCH');
    return 'needs_attention';
  }

  try {
    let alreadyPaid = false;
    await mongoose.connection.transaction(async (session) => {
      const order = await OrderModel.findById(initialOrder._id).session(session);
      if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
      if (order.paymentStatus === 'paid') {
        alreadyPaid = true;
        return;
      }

      if (order.stockReservationStatus !== 'committed') {
        for (const item of order.items) {
          const filter = order.stockReservationStatus === 'active'
            ? { _id: item.product, stockQuantity: { $gte: item.quantity }, reservedQuantity: { $gte: item.quantity } }
            : { _id: item.product, stockQuantity: { $gte: item.quantity } };
          const update = order.stockReservationStatus === 'active'
            ? { $inc: { stockQuantity: -item.quantity, reservedQuantity: -item.quantity } }
            : { $inc: { stockQuantity: -item.quantity } };
          const committed = await ProductModel.updateOne(filter, update, { session });
          if (committed.modifiedCount !== 1) {
            throw new AppError(409, 'INVENTORY_COMMIT_FAILED', 'Paid inventory could not be committed safely.');
          }
        }
      }

      const paidAt = verification.paidAt ?? new Date();
      order.paymentStatus = 'paid';
      order.fulfillmentStatus = 'paid_awaiting_delivery';
      order.stockReservationStatus = 'committed';
      order.paystackTransactionId = verification.transactionId;
      order.paymentVerifiedAt = new Date();
      order.inventoryCommittedAt = new Date();
      order.paidAt = paidAt;
      await order.save({ session });

      await PaymentAttemptModel.updateOne(
        { order: order._id, reference: order.paymentReference },
        {
          $set: {
            status: 'success',
            providerStatus: verification.status,
            providerTransactionId: verification.transactionId,
            verifiedAt: new Date(),
            paidAt,
          },
          $unset: { reconciliationStartedAt: 1, reconciliationLeaseId: 1 },
        },
        { session },
      );

      await CustomerModel.findOneAndUpdate(
        { whatsappNumber: order.customer.whatsappNumber },
        {
          $set: {
            fullName: order.customer.fullName,
            email: order.customer.email,
            defaultDeliveryAddress: order.customer.deliveryAddress,
            lastPaidOrderAt: paidAt,
            status: 'active',
          },
          $setOnInsert: { whatsappConsentAt: paidAt },
          $inc: { paidOrderCount: 1, lifetimeValuePesewas: order.productPaymentTotalPesewas },
        },
        { upsert: true, returnDocument: 'after', session },
      );
      const customer = await CustomerModel.findOne({ whatsappNumber: order.customer.whatsappNumber }).session(session);
      if (customer) {
        order.customerRecord = customer._id;
        await order.save({ session });
      }
    });
    return alreadyPaid ? 'already_paid' : 'paid';
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVENTORY_COMMIT_FAILED') {
      await markPaymentNeedsAttention(initialOrder._id, verification, error.code);
      return 'needs_attention';
    }
    throw error;
  }
}

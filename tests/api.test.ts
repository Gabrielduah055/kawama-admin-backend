import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AppError } from '../src/errors/AppError.js';
import { AdminModel } from '../src/models/AdminSchema.js';
import { CategoryModel } from '../src/models/CategorySchema.js';
import { CustomerModel } from '../src/models/CustomerSchema.js';
import { OrderModel } from '../src/models/OrderSchema.js';
import { PaymentAttemptModel } from '../src/models/PaymentAttemptSchema.js';
import { ProductModel } from '../src/models/ProductSchema.js';
import { ReviewModel } from '../src/models/ReviewSchema.js';
import type { MediaService } from '../src/services/cloudinary.service.js';
import { buildPendingOrderDraft } from '../src/services/order.service.js';
import type {
  InitializePaystackInput,
  PaystackGateway,
  PaystackVerification,
} from '../src/services/paystack.service.js';
import { checkoutCreateSchema } from '../src/validation/schemas.js';

let mongo: MongoMemoryReplSet | undefined;
let mongoDataDirectory: string | undefined;
let paystackInitializationCalls = 0;
let paystackVerificationOverride: PaystackVerification | undefined;
let paystackInitializationError: AppError | undefined;
let paystackConfigurationError: AppError | undefined;
const initializedPayments = new Map<string, InitializePaystackInput>();

const mediaService: MediaService = {
  createUploadSignature: () => ({ timestamp: 1, signature: 'signed', cloudName: 'demo', apiKey: 'key', folder: 'kawama' }),
  destroy: async () => undefined,
  uploadFile: async (_path, publicId) => ({ publicId: `kawama/${publicId}`, src: 'https://example.com/image.png' }),
};

const paystackService: PaystackGateway = {
  assertConfigured: () => {
    if (paystackConfigurationError) throw paystackConfigurationError;
  },
  initializeTransaction: async (input) => {
    paystackInitializationCalls += 1;
    if (paystackInitializationError) throw paystackInitializationError;
    initializedPayments.set(input.reference, input);
    return {
      reference: input.reference,
      accessCode: `access-${input.reference}`,
      authorizationUrl: `https://checkout.paystack.com/${input.reference}`,
    };
  },
  verifyTransaction: async (reference) => {
    if (paystackVerificationOverride) return paystackVerificationOverride;
    const initialized = initializedPayments.get(reference);
    if (!initialized) throw new Error('Payment was not initialized in this test.');
    return {
      transactionId: '4099260516',
      status: 'success',
      reference,
      amountPesewas: initialized.amountPesewas,
      currency: initialized.currency,
      paidAt: new Date('2026-10-14T12:00:00.000Z'),
      customerEmail: initialized.email,
    };
  },
  verifyWebhookSignature: (_rawBody, signature) => signature === 'valid-test-signature',
};

const app = createApp({
  mediaService,
  paystackGateway: paystackService,
  verifyAdminToken: async (token) => {
    if (token !== 'owner') throw new AppError(401, 'INVALID_ADMIN_TOKEN', 'Invalid token.');
    return { uid: 'owner-uid', email: 'owner@example.com' };
  },
});
const databaseAuthApp = createApp({ mediaService, paystackGateway: paystackService });

async function category() {
  return (await CategoryModel.findOne({ slug: 'cookware' })) ??
    CategoryModel.create({ name: 'Cookware', slug: 'cookware', status: 'active', displayOrder: 1 });
}

async function product(overrides: Record<string, unknown> = {}) {
  const selectedCategory = await category();
  return ProductModel.create({
    slug: 'ceramic-pan',
    name: 'Ceramic Pan',
    category: selectedCategory._id,
    shortDescription: 'A useful everyday ceramic pan.',
    description: 'A useful everyday ceramic pan for home cooking.',
    pricePesewas: 28_995,
    images: [{ publicId: 'kawama/products/ceramic-pan', src: 'https://example.com/pan.png', alt: 'Ceramic pan', position: 0 }],
    stockQuantity: 3,
    lowStockThreshold: 5,
    status: 'active',
    ...overrides,
  });
}

async function initializeCheckout(
  selectedProduct: { _id: unknown },
  token: string,
  customer: {
    fullName: string;
    email: string;
    whatsappNumber: string;
    deliveryAddress: string;
  },
  quantity = 1,
) {
  return request(app)
    .post('/api/v1/checkout/sessions')
    .set('idempotency-key', token)
    .send({
      customer: { ...customer, whatsappConsent: true },
      items: [{ productId: String(selectedProduct._id), quantity }],
    });
}

async function payCheckout(checkoutResponse: Awaited<ReturnType<typeof initializeCheckout>>) {
  const reference = checkoutResponse.body.data.payment.reference as string;
  const webhook = await request(app)
    .post('/api/v1/webhooks/paystack')
    .set('x-paystack-signature', 'valid-test-signature')
    .send({ event: 'charge.success', data: { reference } });
  expect(webhook.status).toBe(200);
  return OrderModel.findOne({ paymentReference: reference }).lean();
}

beforeAll(async () => {
  const cacheRoot = path.join(process.cwd(), 'node_modules', '.cache');
  await mkdir(cacheRoot, { recursive: true });
  mongoDataDirectory = await mkdtemp(path.join(cacheRoot, 'kawama-mongo-'));
  mongo = await MongoMemoryReplSet.create({
    instanceOpts: [{ dbPath: mongoDataDirectory, launchTimeout: 30_000 }],
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    AdminModel.syncIndexes(),
    CategoryModel.syncIndexes(),
    CustomerModel.syncIndexes(),
    OrderModel.syncIndexes(),
    PaymentAttemptModel.syncIndexes(),
    ProductModel.syncIndexes(),
    ReviewModel.syncIndexes(),
  ]);
});

beforeEach(async () => {
  paystackInitializationCalls = 0;
  paystackVerificationOverride = undefined;
  paystackInitializationError = undefined;
  paystackConfigurationError = undefined;
  initializedPayments.clear();
  await Promise.all([
    AdminModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    OrderModel.deleteMany({}),
    PaymentAttemptModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ReviewModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  if (mongoDataDirectory) await rm(mongoDataDirectory, { recursive: true, force: true });
});

describe('Kawama API', () => {
  it('reports readiness when MongoDB is connected', async () => {
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.body).toEqual({ status: 'ok', message: 'Kawama API is running' });

    const response = await request(app).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ status: 'ready', database: true });
  });

  it('lists active products using the storefront DTO and inventory derivation', async () => {
    await product();
    await product({ slug: 'hidden-pan', name: 'Hidden Pan', status: 'draft' });
    const response = await request(app).get('/api/v1/products?category=cookware');
    expect(response.status).toBe(200);
    expect(response.body.meta.total).toBe(1);
    expect(response.body.data[0]).toMatchObject({
      slug: 'ceramic-pan',
      category: 'Cookware',
      categorySlug: 'cookware',
      price: 289.95,
      inStock: true,
      stockLevel: 'low_stock',
    });
    const categories = await request(app).get('/api/v1/categories');
    expect(categories.body.data).toEqual([
      expect.objectContaining({ name: 'Cookware', slug: 'cookware', displayOrder: 1 }),
    ]);

    const simplifiedRoute = await request(app).get('/api/product?category=cookware');
    expect(simplifiedRoute.status).toBe(200);
    expect(simplifiedRoute.body.data[0].slug).toBe('ceramic-pan');
  });

  it('allows public storefront requests from any browser origin while protecting admin routes', async () => {
    const storefrontOrigin = 'https://storefront.example.com';
    const categories = await request(app).get('/api/v1/categories').set('origin', storefrontOrigin);
    expect(categories.status).toBe(200);
    expect(categories.headers['access-control-allow-origin']).toBe(storefrontOrigin);

    const reviewPreflight = await request(app)
      .options('/api/v1/products/example-product/reviews')
      .set('origin', storefrontOrigin)
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'content-type');
    expect(reviewPreflight.status).toBe(204);
    expect(reviewPreflight.headers['access-control-allow-origin']).toBe(storefrontOrigin);

    const admin = await request(app).get('/api/v1/admin/products').set('origin', storefrontOrigin);
    expect(admin.status).toBe(403);
    expect(admin.body.error.code).toBe('CORS_ORIGIN_DENIED');
  });

  it('builds and persists an authoritative pending order snapshot', async () => {
    const selectedProduct = await product({ pricePesewas: 40_000, stockQuantity: 4 });
    const checkout = checkoutCreateSchema.parse({
      customer: {
        fullName: 'Ama Mensah',
        email: 'AMA@example.com',
        whatsappNumber: '024 123 4567',
        deliveryAddress: 'East Legon, Accra',
        whatsappConsent: true,
      },
      orderNotes: 'Call when you arrive.',
      items: [{ productId: String(selectedProduct._id), quantity: 2 }],
    });

    const draft = await buildPendingOrderDraft(checkout);
    const order = await OrderModel.create({
      ...draft,
      idempotencyKeyHash: 'a'.repeat(64),
      stockReservationStatus: 'active',
    });

    expect(order.orderNumber).toMatch(/^KWM-\d{8}-[A-F0-9]{6}$/);
    expect(order.customer).toMatchObject({
      fullName: 'Ama Mensah',
      email: 'ama@example.com',
      whatsappNumber: '+233241234567',
      whatsappConsent: true,
    });
    expect(order.items[0]).toMatchObject({
      name: 'Ceramic Pan',
      unitPricePesewas: 40_000,
      quantity: 2,
      lineTotalPesewas: 80_000,
    });
    expect(order).toMatchObject({
      currency: 'GHS',
      subtotalPesewas: 80_000,
      productPaymentTotalPesewas: 80_000,
      deliveryPaymentMethod: 'pay_on_delivery',
      deliveryFeeStatus: 'not_quoted',
      paymentStatus: 'pending',
      fulfillmentStatus: 'awaiting_payment',
    });
  });

  it('rejects duplicate cart lines and insufficient inventory before payment starts', async () => {
    const selectedProduct = await product({ stockQuantity: 1 });
    const baseCheckout = {
      customer: {
        fullName: 'Kojo Owusu',
        email: 'kojo@example.com',
        whatsappNumber: '+233201234567',
        deliveryAddress: 'Adenta, Accra',
        whatsappConsent: true as const,
      },
      items: [{ productId: String(selectedProduct._id), quantity: 2 }],
    };

    const duplicateResult = checkoutCreateSchema.safeParse({
      ...baseCheckout,
      items: [baseCheckout.items[0], baseCheckout.items[0]],
    });
    expect(duplicateResult.success).toBe(false);

    const checkout = checkoutCreateSchema.parse(baseCheckout);
    await expect(buildPendingOrderDraft(checkout)).rejects.toMatchObject({
      status: 409,
      code: 'INSUFFICIENT_STOCK',
    });
  });

  it('initializes an idempotent Paystack checkout and reserves authoritative inventory', async () => {
    const selectedProduct = await product({ pricePesewas: 40_000, stockQuantity: 4 });
    const checkoutToken = 'checkout-token-000000000001';
    const payload = {
      customer: {
        fullName: 'Ama Mensah',
        email: 'ama@example.com',
        whatsappNumber: '0241234567',
        deliveryAddress: 'East Legon, Accra',
        whatsappConsent: true,
      },
      orderNotes: 'Call when you arrive.',
      items: [{ productId: String(selectedProduct._id), quantity: 2 }],
    };

    const created = await request(app)
      .post('/api/v1/checkout/sessions')
      .set('idempotency-key', checkoutToken)
      .send(payload);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      created: true,
      checkoutToken,
      amountPesewas: 80_000,
      currency: 'GHS',
      paymentStatus: 'pending',
      payment: {
        accessCode: expect.stringContaining('access-KWM-'),
        authorizationUrl: expect.stringContaining('https://checkout.paystack.com/KWM-'),
      },
    });
    expect(paystackInitializationCalls).toBe(1);

    const reservedProduct = await ProductModel.findById(selectedProduct._id).lean();
    expect(reservedProduct?.stockQuantity).toBe(4);
    expect(reservedProduct?.reservedQuantity).toBe(2);

    paystackConfigurationError = new AppError(
      503,
      'PAYSTACK_NOT_CONFIGURED',
      'Online payment is temporarily unavailable.',
    );
    const repeated = await request(app)
      .post('/api/v1/checkout/sessions')
      .set('idempotency-key', checkoutToken)
      .send(payload);
    expect(repeated.status).toBe(200);
    expect(repeated.body.data).toMatchObject({ created: false, orderNumber: created.body.data.orderNumber });
    expect(paystackInitializationCalls).toBe(1);
    expect((await ProductModel.findById(selectedProduct._id).lean())?.reservedQuantity).toBe(2);
  });

  it('finalizes a verified Paystack webhook exactly once and updates the customer', async () => {
    const selectedProduct = await product({ pricePesewas: 25_000, stockQuantity: 5 });
    const checkoutToken = 'checkout-token-000000000002';
    const created = await request(app)
      .post('/api/v1/checkout/sessions')
      .set('idempotency-key', checkoutToken)
      .send({
        customer: {
          fullName: 'Esi Boateng',
          email: 'esi@example.com',
          whatsappNumber: '+233501234567',
          deliveryAddress: 'Osu, Accra',
          whatsappConsent: true,
        },
        items: [{ productId: String(selectedProduct._id), quantity: 2 }],
      });
    const reference = created.body.data.payment.reference as string;
    const event = { event: 'charge.success', data: { reference } };

    const firstWebhook = await request(app)
      .post('/api/v1/webhooks/paystack')
      .set('x-paystack-signature', 'valid-test-signature')
      .send(event);
    expect(firstWebhook.status).toBe(200);

    const order = await OrderModel.findOne({ paymentReference: reference }).lean();
    expect(order).toMatchObject({
      paymentStatus: 'paid',
      fulfillmentStatus: 'paid_awaiting_delivery',
      stockReservationStatus: 'committed',
      paystackTransactionId: '4099260516',
    });
    const committedProduct = await ProductModel.findById(selectedProduct._id).lean();
    expect(committedProduct).toMatchObject({ stockQuantity: 3, reservedQuantity: 0 });
    expect(await CustomerModel.findOne({ whatsappNumber: '+233501234567' }).lean()).toMatchObject({
      fullName: 'Esi Boateng',
      paidOrderCount: 1,
      lifetimeValuePesewas: 50_000,
    });

    const duplicateWebhook = await request(app)
      .post('/api/v1/webhooks/paystack')
      .set('x-paystack-signature', 'valid-test-signature')
      .send(event);
    expect(duplicateWebhook.status).toBe(200);
    expect(await ProductModel.findById(selectedProduct._id).lean()).toMatchObject({
      stockQuantity: 3,
      reservedQuantity: 0,
    });
    expect(await CustomerModel.findOne({ whatsappNumber: '+233501234567' }).lean()).toMatchObject({
      paidOrderCount: 1,
      lifetimeValuePesewas: 50_000,
    });

    const status = await request(app).get(`/api/v1/checkout/sessions/${checkoutToken}`);
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({
      orderNumber: created.body.data.orderNumber,
      paymentStatus: 'paid',
      fulfillmentStatus: 'paid_awaiting_delivery',
      amountPesewas: 50_000,
    });
  });

  it('rejects forged webhooks and flags verified amount mismatches for review', async () => {
    const selectedProduct = await product({ pricePesewas: 30_000, stockQuantity: 2 });
    const created = await request(app)
      .post('/api/v1/checkout/sessions')
      .set('idempotency-key', 'checkout-token-000000000003')
      .send({
        customer: {
          fullName: 'Kwame Asare',
          email: 'kwame@example.com',
          whatsappNumber: '+233241111111',
          deliveryAddress: 'Tema Community 12',
          whatsappConsent: true,
        },
        items: [{ productId: String(selectedProduct._id), quantity: 1 }],
      });
    const reference = created.body.data.payment.reference as string;
    const event = { event: 'charge.success', data: { reference } };

    const forged = await request(app)
      .post('/api/v1/webhooks/paystack')
      .set('x-paystack-signature', 'forged')
      .send(event);
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('INVALID_PAYSTACK_SIGNATURE');

    paystackVerificationOverride = {
      transactionId: '999',
      status: 'success',
      reference,
      amountPesewas: 1,
      currency: 'GHS',
      customerEmail: 'kwame@example.com',
    };
    const mismatched = await request(app)
      .post('/api/v1/webhooks/paystack')
      .set('x-paystack-signature', 'valid-test-signature')
      .send(event);
    expect(mismatched.status).toBe(200);
    expect(await OrderModel.findOne({ paymentReference: reference }).lean()).toMatchObject({
      paymentStatus: 'needs_attention',
      fulfillmentStatus: 'needs_attention',
      stockReservationStatus: 'released',
    });
    expect(await ProductModel.findById(selectedProduct._id).lean()).toMatchObject({
      stockQuantity: 2,
      reservedQuantity: 0,
    });
  });

  it('rejects unusable Paystack configuration before creating an order or reserving stock', async () => {
    const selectedProduct = await product({ stockQuantity: 2 });
    paystackConfigurationError = new AppError(
      503,
      'PAYSTACK_NOT_CONFIGURED',
      'Online payment is temporarily unavailable.',
    );

    const response = await request(app)
      .post('/api/v1/checkout/sessions')
      .set('idempotency-key', 'checkout-config-token-00000001')
      .send({
        customer: {
          fullName: 'Akosua Owusu',
          email: 'akosua@example.com',
          whatsappNumber: '+233541111110',
          deliveryAddress: 'Airport Residential, Accra',
          whatsappConsent: true,
        },
        items: [{ productId: String(selectedProduct._id), quantity: 1 }],
      });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('PAYSTACK_NOT_CONFIGURED');
    expect(paystackInitializationCalls).toBe(0);
    expect(await OrderModel.countDocuments()).toBe(0);
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
    expect(await ProductModel.findById(selectedProduct._id).lean()).toMatchObject({
      stockQuantity: 2,
      reservedQuantity: 0,
    });

    const catalogResponse = await request(app).get('/api/v1/products');
    expect(catalogResponse.status).toBe(200);
  });

  it('releases reserved stock after a definitive Paystack authentication rejection', async () => {
    const selectedProduct = await product({ stockQuantity: 2 });
    paystackInitializationError = new AppError(
      502,
      'PAYSTACK_AUTHENTICATION_FAILED',
      'The payment service rejected the server credentials.',
    );

    const response = await request(app)
      .post('/api/v1/checkout/sessions')
      .set('idempotency-key', 'checkout-token-000000000004')
      .send({
        customer: {
          fullName: 'Adwoa Nyarko',
          email: 'adwoa@example.com',
          whatsappNumber: '+233541111111',
          deliveryAddress: 'Spintex Road, Accra',
          whatsappConsent: true,
        },
        items: [{ productId: String(selectedProduct._id), quantity: 1 }],
      });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('PAYSTACK_AUTHENTICATION_FAILED');
    expect(await ProductModel.findById(selectedProduct._id).lean()).toMatchObject({
      stockQuantity: 2,
      reservedQuantity: 0,
    });
    expect(await OrderModel.findOne({ 'customer.email': 'adwoa@example.com' }).lean()).toMatchObject({
      paymentStatus: 'failed',
      fulfillmentStatus: 'cancelled',
      stockReservationStatus: 'released',
    });
  });

  it.each([
    ['PAYSTACK_TIMEOUT', 504],
    ['PAYSTACK_CONNECTION_FAILED', 502],
    ['PAYSTACK_INVALID_RESPONSE', 502],
  ])('preserves the reservation and idempotency context after uncertain %s', async (code, status) => {
    const selectedProduct = await product({ stockQuantity: 2 });
    paystackInitializationError = new AppError(
      status,
      code,
      'The initialization outcome is uncertain.',
    );
    const checkoutToken = `uncertain-${code.toLowerCase()}-0001`;
    const checkoutPayload = {
      customer: {
        fullName: 'Adwoa Nyarko',
        email: 'adwoa@example.com',
        whatsappNumber: '+233541111111',
        deliveryAddress: 'Spintex Road, Accra',
        whatsappConsent: true,
      },
      items: [{ productId: String(selectedProduct._id), quantity: 1 }],
    };

    const response = await request(app)
      .post('/api/v1/checkout/sessions')
      .set('idempotency-key', checkoutToken)
      .send(checkoutPayload);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(await ProductModel.findById(selectedProduct._id).lean()).toMatchObject({
      stockQuantity: 2,
      reservedQuantity: 1,
    });
    const order = await OrderModel.findOne({ 'customer.email': 'adwoa@example.com' }).lean();
    expect(order).toMatchObject({
      paymentStatus: 'pending',
      fulfillmentStatus: 'awaiting_payment',
      stockReservationStatus: 'active',
    });
    expect(await PaymentAttemptModel.findOne({ order: order!._id }).lean()).toMatchObject({
      status: 'initializing',
      lastErrorCode: code,
    });

    const replay = await request(app)
      .post('/api/v1/checkout/sessions')
      .set('idempotency-key', checkoutToken)
      .send(checkoutPayload);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('CHECKOUT_INITIALIZING');
    expect(paystackInitializationCalls).toBe(1);
  });

  it('lists and retrieves protected admin order records without exposing Paystack checkout credentials', async () => {
    const selectedProduct = await product({ pricePesewas: 22_500, stockQuantity: 6 });
    const checkout = await initializeCheckout(
      selectedProduct,
      'admin-order-list-token-0001',
      {
        fullName: 'Esi Admin Test',
        email: 'esi.admin@example.com',
        whatsappNumber: '+233501234560',
        deliveryAddress: 'Labone, Accra',
      },
      2,
    );
    const paidOrder = await payCheckout(checkout);

    const listed = await request(app)
      .get('/api/v1/admin/orders?paymentStatus=paid&q=Esi&from=2020-01-01&to=2030-12-31')
      .set('authorization', 'Bearer owner');
    expect(listed.status).toBe(200);
    expect(listed.body.meta).toMatchObject({ page: 1, limit: 24, total: 1 });
    expect(listed.body.data[0]).toMatchObject({
      id: String(paidOrder?._id),
      customer: { fullName: 'Esi Admin Test', email: 'esi.admin@example.com' },
      itemCount: 1,
      unitCount: 2,
      productPaymentTotalPesewas: 45_000,
      paymentStatus: 'paid',
      fulfillmentStatus: 'paid_awaiting_delivery',
    });

    const detail = await request(app)
      .get(`/api/v1/admin/orders/${paidOrder?._id}`)
      .set('authorization', 'Bearer owner');
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      customer: { deliveryAddress: 'Labone, Accra', whatsappConsent: true },
      items: [{ productId: String(selectedProduct._id), name: 'Ceramic Pan', quantity: 2 }],
      paymentAttempts: [{ status: 'success', amountPesewas: 45_000 }],
    });
    expect(detail.body.data.paymentAttempts[0].accessCode).toBeUndefined();
    expect(detail.body.data.paymentAttempts[0].authorizationUrl).toBeUndefined();
  });

  it('updates delivery and fulfillment safely and releases stock when an unpaid order is cancelled', async () => {
    const selectedProduct = await product({ pricePesewas: 30_000, stockQuantity: 5 });
    const checkout = await initializeCheckout(
      selectedProduct,
      'admin-fulfillment-token-0001',
      {
        fullName: 'Kojo Delivery Test',
        email: 'kojo.delivery@example.com',
        whatsappNumber: '+233201234560',
        deliveryAddress: 'Airport Residential, Accra',
      },
    );
    const paidOrder = await payCheckout(checkout);

    const quoted = await request(app)
      .patch(`/api/v1/admin/orders/${paidOrder?._id}/delivery`)
      .set('authorization', 'Bearer owner')
      .send({ deliveryFeeStatus: 'quoted', deliveryFee: 35.5 });
    expect(quoted.status).toBe(200);
    expect(quoted.body.data).toMatchObject({
      deliveryFeePesewas: 3_550,
      grandTotalPesewas: 33_550,
      deliveryFeeStatus: 'quoted',
    });

    const collected = await request(app)
      .patch(`/api/v1/admin/orders/${paidOrder?._id}/delivery`)
      .set('authorization', 'Bearer owner')
      .send({ deliveryFeeStatus: 'collected' });
    expect(collected.status).toBe(200);
    expect(collected.body.data.deliveryFeePesewas).toBe(3_550);

    const rejectedPaidCancellation = await request(app)
      .patch(`/api/v1/admin/orders/${paidOrder?._id}/fulfillment`)
      .set('authorization', 'Bearer owner')
      .send({ status: 'cancelled' });
    expect(rejectedPaidCancellation.status).toBe(409);
    expect(rejectedPaidCancellation.body.error.code).toBe('PAID_ORDER_REQUIRES_REFUND');

    for (const status of ['processing', 'out_for_delivery', 'delivered']) {
      const updated = await request(app)
        .patch(`/api/v1/admin/orders/${paidOrder?._id}/fulfillment`)
        .set('authorization', 'Bearer owner')
        .send({ status });
      expect(updated.status).toBe(200);
      expect(updated.body.data.fulfillmentStatus).toBe(status);
    }
    expect((await OrderModel.findById(paidOrder?._id).lean())?.deliveredAt).toBeTruthy();

    const pendingProduct = await product({ slug: 'pending-pan', name: 'Pending Pan', stockQuantity: 4 });
    const pendingCheckout = await initializeCheckout(
      pendingProduct,
      'admin-cancel-token-00000001',
      {
        fullName: 'Ama Cancel Test',
        email: 'ama.cancel@example.com',
        whatsappNumber: '+233241234560',
        deliveryAddress: 'Adenta, Accra',
      },
      2,
    );
    const pendingOrder = await OrderModel.findOne({ orderNumber: pendingCheckout.body.data.orderNumber }).lean();
    expect((await ProductModel.findById(pendingProduct._id).lean())?.reservedQuantity).toBe(2);

    const cancelled = await request(app)
      .patch(`/api/v1/admin/orders/${pendingOrder?._id}/fulfillment`)
      .set('authorization', 'Bearer owner')
      .send({ status: 'cancelled' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      paymentStatus: 'failed',
      fulfillmentStatus: 'cancelled',
      stockReservationStatus: 'released',
    });
    expect((await ProductModel.findById(pendingProduct._id).lean())?.reservedQuantity).toBe(0);
  });

  it('lists customer history and returns an operational dashboard summary', async () => {
    const selectedProduct = await product({ pricePesewas: 18_000, stockQuantity: 5, lowStockThreshold: 4 });
    const checkout = await initializeCheckout(
      selectedProduct,
      'admin-customer-token-000001',
      {
        fullName: 'Akosua Customer Test',
        email: 'akosua.customer@example.com',
        whatsappNumber: '+233541234560',
        deliveryAddress: 'East Legon Hills, Accra',
      },
      2,
    );
    const paidOrder = await payCheckout(checkout);
    const customer = await CustomerModel.findOne({ email: 'akosua.customer@example.com' }).lean();

    const listed = await request(app)
      .get('/api/v1/admin/customers?q=Akosua&status=active')
      .set('authorization', 'Bearer owner');
    expect(listed.status).toBe(200);
    expect(listed.body.meta.total).toBe(1);
    expect(listed.body.data[0]).toMatchObject({
      id: String(customer?._id),
      paidOrderCount: 1,
      lifetimeValuePesewas: 36_000,
    });

    const detail = await request(app)
      .get(`/api/v1/admin/customers/${customer?._id}`)
      .set('authorization', 'Bearer owner');
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      orderCount: 1,
      recentOrders: [{ id: String(paidOrder?._id), paymentStatus: 'paid' }],
    });

    const dashboard = await request(app)
      .get('/api/v1/admin/dashboard/summary')
      .set('authorization', 'Bearer owner');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data).toMatchObject({
      orders: { total: 1, paid: 1, awaitingDelivery: 1, needsAttention: 0 },
      revenue: { currency: 'GHS', grossProductRevenuePesewas: 36_000 },
      customers: { total: 1, active: 1, repeat: 0 },
      inventory: { activeProducts: 1, reservedUnits: 0, lowStockProducts: 1 },
      recentOrders: [{ id: String(paidOrder?._id) }],
    });
  });

  it('queues reviews until an administrator approves them', async () => {
    const selectedProduct = await product();
    const submitted = await request(app)
      .post(`/api/v1/products/${selectedProduct._id}/reviews`)
      .send({ reviewerName: 'Ama K.', rating: 5, comment: 'Very useful and easy to clean.' });
    expect(submitted.status).toBe(202);
    expect(submitted.body.data.status).toBe('pending');

    const queue = await request(app)
      .get('/api/v1/admin/reviews?status=pending')
      .set('authorization', 'Bearer owner');
    expect(queue.body.meta.total).toBe(1);

    const beforeApproval = await request(app).get(`/api/v1/products/${selectedProduct._id}/reviews`);
    expect(beforeApproval.body.data).toHaveLength(0);

    const approved = await request(app)
      .patch(`/api/v1/admin/reviews/${submitted.body.data.id}/status`)
      .set('authorization', 'Bearer owner')
      .send({ status: 'approved' });
    expect(approved.status).toBe(200);

    const afterApproval = await request(app).get(`/api/v1/products/${selectedProduct._id}/reviews`);
    expect(afterApproval.body.data).toHaveLength(1);
  });

  it('logs in with the database administrator and accepts its JWT', async () => {
    const password = 'A-secure-test-password-79.';
    await AdminModel.create({
      email: 'owner@example.com',
      passwordHash: await bcrypt.hash(password, 4),
      role: 'owner',
      active: true,
    });

    const loggedIn = await request(databaseAuthApp)
      .post('/api/admin/login')
      .send({ email: 'OWNER@example.com', password });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.body.data).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 43_200,
      admin: { email: 'owner@example.com', role: 'owner' },
    });
    expect(loggedIn.body.data.token).toEqual(expect.any(String));
    expect(loggedIn.body.data.admin.passwordHash).toBeUndefined();

    const protectedResponse = await request(databaseAuthApp)
      .get('/api/v1/admin/products')
      .set('authorization', `Bearer ${loggedIn.body.data.token}`);
    expect(protectedResponse.status).toBe(200);

    const rejected = await request(databaseAuthApp)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@example.com', password: 'wrong-password' });
    expect(rejected.status).toBe(401);
    expect(rejected.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects protected requests without an administrator bearer token', async () => {
    const response = await request(app).get('/api/v1/admin/products');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('ADMIN_TOKEN_REQUIRED');
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('creates, archives, and restores products while keeping the slug stable', async () => {
    const selectedCategory = await category();
    const created = await request(app)
      .post('/api/v1/admin/products')
      .set('authorization', 'Bearer owner')
      .send({
        slug: 'glass-bowl',
        name: 'Glass Bowl',
        categoryId: String(selectedCategory._id),
        shortDescription: 'A clear serving and mixing bowl.',
        description: 'A clear serving and mixing bowl for everyday use.',
        price: 120,
        images: [{ publicId: 'kawama/products/glass-bowl', src: 'https://example.com/bowl.png', alt: 'Glass bowl', position: 0 }],
        stockQuantity: 8,
        lowStockThreshold: 3,
        status: 'active',
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await request(app).get(`/api/v1/admin/products/${id}`).set('authorization', 'Bearer owner')).status).toBe(200);
    const adminList = await request(app).get('/api/v1/admin/products?status=active').set('authorization', 'Bearer owner');
    expect(adminList.body.meta.total).toBe(1);

    const immutable = await request(app)
      .patch(`/api/v1/admin/products/${id}`)
      .set('authorization', 'Bearer owner')
      .send({ slug: 'changed-slug' });
    expect(immutable.status).toBe(422);

    const archived = await request(app)
      .delete(`/api/v1/admin/products/${id}`)
      .set('authorization', 'Bearer owner');
    expect(archived.body.data.status).toBe('archived');
    expect((await request(app).get('/api/v1/products/glass-bowl')).status).toBe(404);

    const restored = await request(app)
      .post(`/api/v1/admin/products/${id}/restore`)
      .set('authorization', 'Bearer owner');
    expect(restored.body.data.status).toBe('draft');
    expect(restored.body.data.slug).toBe('glass-bowl');
  });

  it('accepts immutable bundled storefront images without treating them as Cloudinary uploads', async () => {
    const selectedCategory = await category();
    const src = 'https://raw.githubusercontent.com/Gabrielduah055/Kawama/9306e51587963f5f4616eab6db7c49d1e4df0ea0/public/images/product-mixing-bowls.webp';
    const created = await request(app)
      .post('/api/v1/admin/products')
      .set('authorization', 'Bearer owner')
      .send({
        slug: 'mixing-bowls',
        name: 'Mixing Bowls',
        categoryId: String(selectedCategory._id),
        shortDescription: 'A useful set of mixing bowls.',
        description: 'A useful set of mixing bowls for everyday preparation.',
        price: 245,
        images: [{ src, alt: 'Four sea-green ceramic mixing bowls', position: 0 }],
        stockQuantity: 8,
        status: 'active',
      });

    expect(created.status).toBe(201);
    expect(created.body.data.images[0]).toMatchObject({ src });
    expect(created.body.data.images[0].publicId).toBeUndefined();

    const updated = await request(app)
      .patch(`/api/v1/admin/products/${created.body.data.id}`)
      .set('authorization', 'Bearer owner')
      .send({ price: 250 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.price).toBe(250);
  });

  it('prevents archival of a category still used by a non-archived product', async () => {
    const selectedProduct = await product();
    const response = await request(app)
      .delete(`/api/v1/admin/categories/${selectedProduct.category}`)
      .set('authorization', 'Bearer owner');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CATEGORY_IN_USE');
  });

  it('supports the complete category lifecycle and ordering contract', async () => {
    const created = await request(app)
      .post('/api/v1/admin/categories')
      .set('authorization', 'Bearer owner')
      .send({
        name: 'Storage',
        slug: 'storage',
        description: 'Kitchen storage.',
        image: { publicId: 'kawama/categories/storage', src: 'https://example.com/storage.png', alt: 'Storage containers' },
        displayOrder: 4,
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const updated = await request(app)
      .patch(`/api/v1/admin/categories/${id}`)
      .set('authorization', 'Bearer owner')
      .send({ name: 'Kitchen Storage' });
    expect(updated.body.data).toMatchObject({ name: 'Kitchen Storage', slug: 'storage' });

    const reordered = await request(app)
      .patch('/api/v1/admin/categories/order')
      .set('authorization', 'Bearer owner')
      .send({ items: [{ id, displayOrder: 1 }] });
    expect(reordered.body.data.updated).toBe(1);

    const archived = await request(app)
      .delete(`/api/v1/admin/categories/${id}`)
      .set('authorization', 'Bearer owner');
    expect(archived.body.data.status).toBe('archived');

    const restored = await request(app)
      .post(`/api/v1/admin/categories/${id}/restore`)
      .set('authorization', 'Bearer owner');
    expect(restored.body.data.status).toBe('active');
  });

  it('returns the Cloudinary direct-upload contract to the owner', async () => {
    const response = await request(app)
      .post('/api/v1/admin/uploads/signature')
      .set('authorization', 'Bearer owner');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      timestamp: 1,
      signature: 'signed',
      cloudName: 'demo',
      apiKey: 'key',
      folder: 'kawama',
    });
  });

  it('returns conflict and category validation errors for invalid product creation', async () => {
    const existing = await product();
    const basePayload = {
      slug: 'ceramic-pan',
      name: 'Duplicate Pan',
      categoryId: String(existing.category),
      shortDescription: 'A complete short description.',
      description: 'A complete product description for the duplicate product.',
      price: 100,
      images: [{ publicId: 'kawama/products/duplicate-pan', src: 'https://example.com/duplicate.png', alt: 'Duplicate pan', position: 0 }],
      status: 'active',
    };
    const duplicate = await request(app)
      .post('/api/v1/admin/products')
      .set('authorization', 'Bearer owner')
      .send(basePayload);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_RESOURCE');

    const invalidCategory = await request(app)
      .post('/api/v1/admin/products')
      .set('authorization', 'Bearer owner')
      .send({ ...basePayload, slug: 'another-pan', categoryId: new mongoose.Types.ObjectId().toString() });
    expect(invalidCategory.status).toBe(400);
    expect(invalidCategory.body.error.code).toBe('INVALID_CATEGORY');
  });

  it('does not destroy a Cloudinary asset while a product references it', async () => {
    await product();
    const response = await request(app)
      .delete('/api/v1/admin/uploads')
      .set('authorization', 'Bearer owner')
      .send({ publicId: 'kawama/products/ceramic-pan' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ASSET_IN_USE');
  });
});

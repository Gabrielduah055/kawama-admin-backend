import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetEnvironmentForTests } from '../src/config/environment.js';
import { CategoryModel } from '../src/models/CategorySchema.js';
import { ProductModel } from '../src/models/ProductSchema.js';

const integrationKey = 'orderbridge-test-key-0123456789abcdef';
const managedEnvironmentKeys = [
  'STOREFRONT_PRODUCT_URL_TEMPLATE',
  'STORE_DELIVERY_POLICY',
  'STORE_PAYMENT_POLICY',
  'STORE_RETURN_POLICY',
  'STORE_CONTACT_EMAIL',
  'STORE_CONTACT_PHONE',
  'STORE_CONTACT_WHATSAPP_URL',
] as const;
const originalEnvironment = new Map(managedEnvironmentKeys.map((key) => [key, process.env[key]]));

let app: ReturnType<typeof createApp>;
let mongo: MongoMemoryServer | undefined;
let mongoDataDirectory: string | undefined;

async function seedProduct(overrides: Record<string, unknown> = {}) {
  const category = (await CategoryModel.findOne({ slug: 'cookware' })) ?? await CategoryModel.create({
    name: 'Cookware',
    slug: 'cookware',
    status: 'active',
  });
  return ProductModel.create({
    slug: 'ceramic-pan',
    name: 'Ceramic Pan',
    category: category._id,
    shortDescription: 'A ceramic pan for everyday meals.',
    description: 'A durable ceramic pan for everyday home cooking.',
    pricePesewas: 35_000,
    images: [{ src: 'https://assets.example.com/pan.png', alt: 'Ceramic pan', position: 0 }],
    stockQuantity: 6,
    reservedQuantity: 2,
    lowStockThreshold: 2,
    specifications: [{ label: 'Material', value: 'Ceramic' }],
    status: 'active',
    ...overrides,
  });
}

function authorized() {
  return { authorization: `Bearer ${integrationKey}` };
}

beforeAll(async () => {
  process.env.STOREFRONT_PRODUCT_URL_TEMPLATE = 'https://shop.example.com/products/{slug}';
  process.env.STORE_DELIVERY_POLICY = 'Delivery fees are quoted separately and paid on delivery.';
  process.env.STORE_PAYMENT_POLICY = 'Product payments are processed securely before fulfilment.';
  process.env.STORE_RETURN_POLICY = 'Unused items may be returned within seven days.';
  process.env.STORE_CONTACT_EMAIL = 'support@kawama.example';
  process.env.STORE_CONTACT_PHONE = '+233 20 000 0000';
  process.env.STORE_CONTACT_WHATSAPP_URL = 'https://wa.me/233200000000';
  resetEnvironmentForTests();
  app = createApp({ orderBridgeApiKey: integrationKey });

  const cacheRoot = path.join(process.cwd(), 'node_modules', '.cache');
  await mkdir(cacheRoot, { recursive: true });
  mongoDataDirectory = await mkdtemp(path.join(cacheRoot, 'kawama-orderbridge-mongo-'));
  mongo = await MongoMemoryServer.create({ instance: { dbPath: mongoDataDirectory, launchTimeout: 30_000 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([CategoryModel.syncIndexes(), ProductModel.syncIndexes()]);
});

beforeEach(async () => {
  await Promise.all([CategoryModel.deleteMany({}), ProductModel.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  if (mongoDataDirectory) await rm(mongoDataDirectory, { recursive: true, force: true });
  for (const key of managedEnvironmentKeys) {
    const original = originalEnvironment.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  resetEnvironmentForTests();
});

describe('OrderBridge commerce integration', () => {
  it('requires the exact server-side bearer key without exposing it', async () => {
    const missing = await request(app).get('/api/integrations/orderbridge/policies');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('ORDERBRIDGE_API_KEY_REQUIRED');

    const invalid = await request(app)
      .get('/api/integrations/orderbridge/policies')
      .set('authorization', 'Bearer wrong-key');
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe('INVALID_ORDERBRIDGE_API_KEY');
    expect(JSON.stringify(invalid.body)).not.toContain(integrationKey);
  });

  it('searches active database products with authoritative filters and OrderBridge fields', async () => {
    await seedProduct();
    await seedProduct({ slug: 'small-ceramic-pan', name: 'Small Ceramic Pan', pricePesewas: 25_000, stockQuantity: 3, reservedQuantity: 0 });
    await seedProduct({ slug: 'sold-out-pan', name: 'Sold Out Ceramic Pan', pricePesewas: 30_000, stockQuantity: 2, reservedQuantity: 2 });
    await seedProduct({ slug: 'draft-pan', name: 'Draft Ceramic Pan', pricePesewas: 32_000, status: 'draft' });

    const response = await request(app)
      .get('/api/integrations/orderbridge/products/search')
      .set(authorized())
      .query({ category: 'Cookware', minPrice: 200, maxPrice: 400, available: true, sort: 'price_desc', limit: 10 });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.products.map((product: { name: string }) => product.name)).toEqual([
      'Ceramic Pan',
      'Small Ceramic Pan',
    ]);
    expect(response.body.products[0]).toEqual({
      id: expect.any(String),
      name: 'Ceramic Pan',
      description: 'A durable ceramic pan for everyday home cooking.',
      price: 350,
      currency: 'GHS',
      available: true,
      stockQuantity: 4,
      specifications: { Material: 'Ceramic' },
      canonicalUrl: 'https://shop.example.com/products/ceramic-pan',
    });
    expect(JSON.stringify(response.body)).not.toMatch(/reservedQuantity|updatedBy|publicId/);
  });

  it('does not let preferences exclude valid query matches and treats preference-only searches as alternatives', async () => {
    await seedProduct();
    await seedProduct({
      slug: 'stainless-pot',
      name: 'Stainless Pot',
      description: 'A quiet stainless pot for soups.',
      pricePesewas: 40_000,
      specifications: [{ label: 'Material', value: 'Stainless steel' }],
    });

    const queryWithPreference = await request(app)
      .get('/api/integrations/orderbridge/products/search')
      .set(authorized())
      .query({ query: 'ceramic', preference: 'quiet', limit: 10 });
    expect(queryWithPreference.status).toBe(200);
    expect(queryWithPreference.body.products.map((product: { name: string }) => product.name)).toContain('Ceramic Pan');

    const preferenceOnly = await request(app)
      .get('/api/integrations/orderbridge/products/search')
      .set(authorized())
      .query({ preference: ['ceramic', 'stainless'], sort: 'price_asc', limit: 10 });
    expect(preferenceOnly.status).toBe(200);
    expect(preferenceOnly.body.products.map((product: { name: string }) => product.name)).toEqual([
      'Ceramic Pan',
      'Stainless Pot',
    ]);
  });

  it('reports the unique preference match total before applying the response limit', async () => {
    await seedProduct();
    await seedProduct({
      slug: 'quiet-stainless-pot',
      name: 'Quiet Stainless Pot',
      description: 'A quiet stainless pot for soups.',
    });
    await seedProduct({
      slug: 'quiet-ceramic-bowl',
      name: 'Quiet Ceramic Bowl',
      description: 'A quiet ceramic bowl for serving.',
    });

    const response = await request(app)
      .get('/api/integrations/orderbridge/products/search')
      .set(authorized())
      .query({ preference: ['ceramic', 'quiet'], limit: 1 });

    expect(response.status).toBe(200);
    expect(response.body.products).toHaveLength(1);
    expect(response.body.total).toBe(3);
  });

  it('returns active product details, live available stock, policies, and safe not-found responses', async () => {
    const product = await seedProduct();
    const productId = String(product._id);

    const detail = await request(app)
      .get(`/api/integrations/orderbridge/products/${productId}`)
      .set(authorized());
    expect(detail.status).toBe(200);
    expect(detail.body.product).toMatchObject({ id: productId, available: true, stockQuantity: 4 });

    const availability = await request(app)
      .get(`/api/integrations/orderbridge/products/${productId.toUpperCase()}/availability`)
      .set(authorized());
    expect(availability.status).toBe(200);
    expect(availability.body).toEqual({ productId, available: true, stockQuantity: 4 });

    const policies = await request(app)
      .get('/api/integrations/orderbridge/policies?topic=return')
      .set(authorized());
    expect(policies.status).toBe(200);
    expect(policies.body).toEqual({
      policies: [{ name: 'Returns', content: 'Unused items may be returned within seven days.' }],
    });

    const integrationPolicies = await request(app)
      .get('/api/integrations/orderbridge/policies')
      .set(authorized());
    expect(integrationPolicies.body.policies).toEqual(expect.arrayContaining([
      {
        name: 'Checkout',
        content: 'Currency: GHS. Product payment provider: Paystack. Product payment scope: products only. Delivery payment method: pay on delivery.',
      },
      {
        name: 'Contact',
        content: 'Email: support@kawama.example. Phone: +233 20 000 0000. WhatsApp: https://wa.me/233200000000.',
      },
    ]));

    await ProductModel.findByIdAndUpdate(productId, { status: 'archived' });
    const archived = await request(app)
      .get(`/api/integrations/orderbridge/products/${productId}`)
      .set(authorized());
    expect(archived.status).toBe(404);
    expect(archived.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('rejects unsupported or contradictory search input before querying', async () => {
    const missingCriteria = await request(app)
      .get('/api/integrations/orderbridge/products/search')
      .set(authorized());
    expect(missingCriteria.status).toBe(422);
    expect(missingCriteria.body.error.code).toBe('VALIDATION_ERROR');

    const invalidRange = await request(app)
      .get('/api/integrations/orderbridge/products/search?category=Cookware&minPrice=500&maxPrice=200')
      .set(authorized());
    expect(invalidRange.status).toBe(422);
    expect(invalidRange.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'maxPrice' }),
    ]));
  });
});

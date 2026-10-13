import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AppError } from '../src/errors/AppError.js';
import { AdminModel } from '../src/models/AdminSchema.js';
import { CategoryModel } from '../src/models/CategorySchema.js';
import { ProductModel } from '../src/models/ProductSchema.js';
import { ReviewModel } from '../src/models/ReviewSchema.js';
import type { MediaService } from '../src/services/cloudinary.service.js';

let mongo: MongoMemoryServer | undefined;
let mongoDataDirectory: string | undefined;

const mediaService: MediaService = {
  createUploadSignature: () => ({ timestamp: 1, signature: 'signed', cloudName: 'demo', apiKey: 'key', folder: 'kawama' }),
  destroy: async () => undefined,
  uploadFile: async (_path, publicId) => ({ publicId: `kawama/${publicId}`, src: 'https://example.com/image.png' }),
};

const app = createApp({
  mediaService,
  verifyAdminToken: async (token) => {
    if (token !== 'owner') throw new AppError(401, 'INVALID_ADMIN_TOKEN', 'Invalid token.');
    return { uid: 'owner-uid', email: 'owner@example.com' };
  },
});
const databaseAuthApp = createApp({ mediaService });

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

beforeAll(async () => {
  const cacheRoot = path.join(process.cwd(), 'node_modules', '.cache');
  await mkdir(cacheRoot, { recursive: true });
  mongoDataDirectory = await mkdtemp(path.join(cacheRoot, 'kawama-mongo-'));
  mongo = await MongoMemoryServer.create({ instance: { dbPath: mongoDataDirectory, launchTimeout: 30_000 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([AdminModel.syncIndexes(), CategoryModel.syncIndexes(), ProductModel.syncIndexes(), ReviewModel.syncIndexes()]);
});

beforeEach(async () => {
  await Promise.all([AdminModel.deleteMany({}), CategoryModel.deleteMany({}), ProductModel.deleteMany({}), ReviewModel.deleteMany({})]);
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

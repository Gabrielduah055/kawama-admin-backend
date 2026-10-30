import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetEnvironmentForTests } from '../src/config/environment.js';
import { CategoryModel } from '../src/models/CategorySchema.js';
import { OrderBridgeChatSessionModel } from '../src/models/OrderBridgeChatSessionSchema.js';
import { ProductModel } from '../src/models/ProductSchema.js';
import {
  createOrderBridgeWebsiteClient,
  type OrderBridgeWebsiteClient,
  type OrderBridgeWebsiteMessage,
  type OrderBridgeWebsiteResponse,
} from '../src/services/orderbridge-website-client.service.js';

const businessId = '0123456789abcdef01234567';
const otherBusinessId = 'fedcba987654321001234567';
const upstreamConversationId = 'A'.repeat(43);
const upstreamConversationToken = `v1.${'B'.repeat(43)}`;
const integrationKey = 'website-integration-key-that-is-server-only';

let mongo: MongoMemoryServer | undefined;
let mongoDataDirectory: string | undefined;
const originalChatEnabled = process.env.AI_CHAT_ENABLED;

class StubOrderBridgeClient implements OrderBridgeWebsiteClient {
  public readonly calls: OrderBridgeWebsiteMessage[] = [];

  constructor(
    public readonly businessId: string,
    private readonly responder: (
      input: OrderBridgeWebsiteMessage,
      call: number,
    ) => OrderBridgeWebsiteResponse | Promise<OrderBridgeWebsiteResponse>,
  ) {}

  async sendMessage(input: OrderBridgeWebsiteMessage): Promise<OrderBridgeWebsiteResponse> {
    this.calls.push(input);
    return this.responder(input, this.calls.length);
  }
}

function upstreamResponse(overrides: Partial<OrderBridgeWebsiteResponse> = {}): OrderBridgeWebsiteResponse {
  return {
    success: true,
    message: 'Here is the verified product.',
    conversation: {
      conversationId: upstreamConversationId,
      conversationToken: upstreamConversationToken,
    },
    ...overrides,
  };
}

async function seedProduct() {
  const category = await CategoryModel.create({
    name: 'Appliances',
    slug: 'appliances',
    status: 'active',
  });
  return ProductModel.create({
    slug: 'smoothie-blender',
    name: 'Smoothie Blender',
    category: category._id,
    pricePesewas: 35_000,
    images: [{ src: 'https://cdn.example/blender.png', alt: 'Smoothie blender', position: 0 }],
    stockQuantity: 2,
    lowStockThreshold: 2,
    status: 'active',
  });
}

beforeAll(async () => {
  const cacheRoot = path.join(process.cwd(), 'node_modules', '.cache');
  await mkdir(cacheRoot, { recursive: true });
  mongoDataDirectory = await mkdtemp(path.join(cacheRoot, 'kawama-orderbridge-chat-'));
  mongo = await MongoMemoryServer.create({ instance: { dbPath: mongoDataDirectory, launchTimeout: 30_000 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    CategoryModel.syncIndexes(),
    ProductModel.syncIndexes(),
    OrderBridgeChatSessionModel.syncIndexes(),
  ]);
});

beforeEach(async () => {
  process.env.AI_CHAT_ENABLED = 'true';
  resetEnvironmentForTests();
  await Promise.all([
    CategoryModel.deleteMany({}),
    ProductModel.deleteMany({}),
    OrderBridgeChatSessionModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (originalChatEnabled === undefined) delete process.env.AI_CHAT_ENABLED;
  else process.env.AI_CHAT_ENABLED = originalChatEnabled;
  resetEnvironmentForTests();
  await mongoose.disconnect();
  await mongo?.stop();
  if (mongoDataDirectory) await rm(mongoDataDirectory, { recursive: true, force: true });
});

describe('OrderBridge website chat adapter', () => {
  it('maps verified products and preserves the server-side upstream conversation', async () => {
    const product = await seedProduct();
    const client = new StubOrderBridgeClient(businessId, () => upstreamResponse({
      data: {
        products: [{
          id: String(product._id),
          name: 'Smoothie Blender',
          price: 350,
          currency: 'GHS',
          available: true,
          canonicalUrl: 'https://shop.example/products/smoothie-blender',
        }],
      },
    }));
    const app = createApp({ chatEngine: 'orderbridge', orderBridgeWebsiteClient: client });

    const first = await request(app).post('/api/ai/chat').send({ message: 'Show me a blender.' });

    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      assistantMessage: 'Here is the verified product.',
      products: [{
        id: String(product._id),
        slug: 'smoothie-blender',
        name: 'Smoothie Blender',
        price: 350,
        currency: 'GHS',
        availability: 'low_stock',
        image: { src: 'https://cdn.example/blender.png', alt: 'Smoothie blender' },
        url: 'https://shop.example/products/smoothie-blender',
      }],
    });
    expect(first.body.data.suggestedFollowUps).toBeUndefined();
    expect(JSON.stringify(first.body)).not.toContain(upstreamConversationToken);
    expect(client.calls[0]?.conversation).toBeUndefined();

    const second = await request(app)
      .post('/api/ai/chat')
      .set('X-Chat-Session', String(first.headers['x-chat-session']))
      .send({ conversationId: first.body.data.conversationId, message: 'Which one is available?' });

    expect(second.status).toBe(200);
    expect(client.calls[1]?.conversation).toEqual({
      conversationId: upstreamConversationId,
      conversationToken: upstreamConversationToken,
    });
  });

  it('isolates conversations between visitors and configured businesses', async () => {
    const client = new StubOrderBridgeClient(businessId, () => upstreamResponse());
    const initial = await request(createApp({ chatEngine: 'orderbridge', orderBridgeWebsiteClient: client }))
      .post('/api/ai/chat')
      .send({ message: 'Hello' });

    const stolen = await request(createApp({ chatEngine: 'orderbridge', orderBridgeWebsiteClient: client }))
      .post('/api/ai/chat')
      .set('X-Chat-Session', 'Z'.repeat(43))
      .send({ conversationId: initial.body.data.conversationId, message: 'Continue' });
    expect(stolen.status).toBe(404);

    const otherClient = new StubOrderBridgeClient(otherBusinessId, () => upstreamResponse());
    const crossedBusiness = await request(createApp({
      chatEngine: 'orderbridge',
      orderBridgeWebsiteClient: otherClient,
    }))
      .post('/api/ai/chat')
      .set('X-Chat-Session', String(initial.headers['x-chat-session']))
      .send({ conversationId: initial.body.data.conversationId, message: 'Continue' });
    expect(crossedBusiness.status).toBe(404);
    expect(client.calls).toHaveLength(1);
    expect(otherClient.calls).toHaveLength(0);
  });

  it('authenticates with the website integration key without placing it in the payload', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify(upstreamResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const client = createOrderBridgeWebsiteClient({
      baseUrl: 'https://orderbridge.example',
      businessId,
      integrationKey,
      timeoutMs: 1_000,
    }, fetchImpl);

    await client.sendMessage({ message: 'Show me blenders.', requestId: 'request-123' });

    expect(requestUrl).toBe(`https://orderbridge.example/api/integrations/website-chat/${businessId}/messages`);
    expect(new Headers(requestInit?.headers).get('authorization')).toBe(`Bearer ${integrationKey}`);
    expect(new Headers(requestInit?.headers).get('x-request-id')).toBe('request-123');
    expect(requestInit?.body).toBe(JSON.stringify({ message: 'Show me blenders.' }));
    expect(String(requestInit?.body)).not.toContain(integrationKey);
  });

  it('returns a safe error when OrderBridge is unavailable', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(
      JSON.stringify({ message: 'private upstream stack trace', credential: integrationKey }),
      { status: 503 },
    );
    const client = createOrderBridgeWebsiteClient({
      baseUrl: 'https://orderbridge.example',
      businessId,
      integrationKey,
      timeoutMs: 1_000,
    }, fetchImpl);

    const response = await request(createApp({ chatEngine: 'orderbridge', orderBridgeWebsiteClient: client }))
      .post('/api/ai/chat')
      .send({ message: 'Show me blenders.' });

    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: 'ORDERBRIDGE_CHAT_UNAVAILABLE',
      message: 'The shopping assistant is temporarily unavailable.',
    });
    expect(JSON.stringify(response.body)).not.toContain('private upstream stack trace');
    expect(JSON.stringify(response.body)).not.toContain(integrationKey);
    expect(response.headers['x-chat-session']).toBeUndefined();
  });
});

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetEnvironmentForTests } from '../src/config/environment.js';
import { CategoryModel } from '../src/models/CategorySchema.js';
import { ChatConversationModel } from '../src/models/ChatConversationSchema.js';
import { ProductModel } from '../src/models/ProductSchema.js';
import { executeShoppingTool } from '../src/services/chat-tools.service.js';
import { createOpenRouterProvider, type ChatCompletionRequest, type ChatProvider, type ProviderMessage } from '../src/services/openrouter.service.js';

let mongo: MongoMemoryServer | undefined;
let mongoDataDirectory: string | undefined;

class ScriptedProvider implements ChatProvider {
  public calls: ChatCompletionRequest[] = [];

  constructor(private readonly handler: (input: ChatCompletionRequest, call: number) => ProviderMessage | Promise<ProviderMessage>) {}

  async complete(input: ChatCompletionRequest): Promise<ProviderMessage> {
    this.calls.push(input);
    return this.handler(input, this.calls.length);
  }
}

async function seedProduct(overrides: Record<string, unknown> = {}) {
  const category = (await CategoryModel.findOne({ slug: 'appliances' })) ?? await CategoryModel.create({
    name: 'Appliances',
    slug: 'appliances',
    status: 'active',
  });
  return ProductModel.create({
    slug: 'smoothie-blender',
    name: 'Smoothie Blender',
    category: category._id,
    shortDescription: 'A compact blender for smoothies.',
    description: 'A compact countertop blender for fruit smoothies.',
    pricePesewas: 35_000,
    images: [{ src: 'https://example.com/blender.png', alt: 'Smoothie blender', position: 0 }],
    stockQuantity: 5,
    lowStockThreshold: 2,
    details: ['Two speed settings'],
    specifications: [{ label: 'Jug material', value: 'BPA-free plastic' }],
    status: 'active',
    ...overrides,
  });
}

function toolCall(id: string, name: string, argumentsValue: Record<string, unknown>): ProviderMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(argumentsValue) } }],
  };
}

function finalMessage(assistantMessage: string, productIds: string[] = [], suggestedFollowUps: string[] = []): ProviderMessage {
  return {
    role: 'assistant',
    content: JSON.stringify({ assistantMessage, productIds, suggestedFollowUps }),
  };
}

function productsFromLastTool(input: ChatCompletionRequest): Array<Record<string, unknown>> {
  const toolMessage = [...input.messages].reverse().find((message) => message.role === 'tool');
  if (!toolMessage?.content) return [];
  const parsed = JSON.parse(toolMessage.content) as { products?: Array<Record<string, unknown>> };
  return parsed.products ?? [];
}

beforeAll(async () => {
  const cacheRoot = path.join(process.cwd(), 'node_modules', '.cache');
  await mkdir(cacheRoot, { recursive: true });
  mongoDataDirectory = await mkdtemp(path.join(cacheRoot, 'kawama-chat-mongo-'));
  mongo = await MongoMemoryServer.create({ instance: { dbPath: mongoDataDirectory, launchTimeout: 30_000 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    CategoryModel.syncIndexes(),
    ProductModel.syncIndexes(),
    ChatConversationModel.syncIndexes(),
  ]);
});

beforeEach(async () => {
  await Promise.all([
    CategoryModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ChatConversationModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  if (mongoDataDirectory) await rm(mongoDataDirectory, { recursive: true, force: true });
});

describe('shopping chat API', () => {
  it('searches by category and budget and returns canonical product cards', async () => {
    const selected = await seedProduct();
    await seedProduct({ slug: 'premium-blender', name: 'Premium Blender', pricePesewas: 65_000 });
    const provider = new ScriptedProvider((input, call) => {
      if (call === 1) {
        return toolCall('search-1', 'searchProducts', {
          query: 'blender', category: 'Appliances', maxPrice: 400, availability: 'in_stock', limit: 4,
        });
      }
      const products = productsFromLastTool(input);
      return finalMessage('The Smoothie Blender fits your GHS 400 budget and is currently available.', products.map((product) => String(product.id)), ['Would you like its specifications?']);
    });
    const app = createApp({ chatProvider: provider });

    const response = await request(app).post('/api/ai/chat').send({ message: 'I need a blender under 400 cedis.' });

    expect(response.status).toBe(200);
    expect(response.headers['x-chat-session']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.body.data).toMatchObject({
      conversationId: expect.any(String),
      assistantMessage: expect.stringContaining('GHS 400'),
      products: [{
        id: String(selected._id),
        name: 'Smoothie Blender',
        price: 350,
        currency: 'GHS',
        availability: 'in_stock',
      }],
    });
    expect(response.body.data.products).toHaveLength(1);
    expect(provider.calls).toHaveLength(2);
  });

  it('preserves shown-product order for follow-up comparisons and rechecks details', async () => {
    const first = await seedProduct({ slug: 'first-blender', name: 'First Blender', pricePesewas: 30_000 });
    const second = await seedProduct({ slug: 'second-blender', name: 'Second Blender', pricePesewas: 38_000 });
    const provider = new ScriptedProvider((input) => {
      const userMessage = [...input.messages].reverse().find((message) => message.role === 'user')?.content;
      const lastTool = [...input.messages].reverse().find((message) => message.role === 'tool');
      if (!lastTool && userMessage?.includes('Show me')) {
        return toolCall('list', 'searchProducts', { query: 'blender', sort: 'price_asc', limit: 4 });
      }
      if (lastTool && userMessage?.includes('Show me')) {
        const products = productsFromLastTool(input);
        return finalMessage('Here are two options.', products.map((product) => String(product.id)));
      }
      if (!lastTool && userMessage?.includes('Compare')) {
        const system = input.messages[0]!.content ?? '';
        const ids = [...system.matchAll(/id: ([a-f\d]{24})/gi)].map((match) => match[1]!);
        return toolCall('compare', 'getProductDetails', { identifiers: ids });
      }
      const products = productsFromLastTool(input);
      return finalMessage('The first costs less; the second has its own recorded details.', products.map((product) => String(product.id)));
    });
    const app = createApp({ chatProvider: provider });

    const initial = await request(app).post('/api/ai/chat').send({ message: 'Show me two blenders.' });
    expect(initial.body.data.products.map((product: { id: string }) => product.id)).toEqual([String(first._id), String(second._id)]);

    const followUp = await request(app)
      .post('/api/ai/chat')
      .set('x-chat-session', String(initial.headers['x-chat-session']))
      .send({ conversationId: initial.body.data.conversationId, message: 'Compare the first and second.' });

    expect(followUp.status).toBe(200);
    expect(followUp.body.data.products.map((product: { id: string }) => product.id)).toEqual([String(first._id), String(second._id)]);
    const followUpSystem = provider.calls[2]!.messages[0]!.content;
    expect(followUpSystem).toContain(`1. First Blender (id: ${first._id}`);
    expect(followUpSystem).toContain(`2. Second Blender (id: ${second._id}`);
  });

  it('distinguishes missing specifications and current unavailability', async () => {
    const unavailable = await seedProduct({ stockQuantity: 0, details: [], specifications: [] });
    const provider = new ScriptedProvider((input, call) => call === 1
      ? toolCall('details', 'getProductDetails', { identifiers: [String(unavailable._id)] })
      : finalMessage('This item is out of stock. Its warranty is not recorded, so I cannot confirm one.', [String(unavailable._id)]));
    const response = await request(createApp({ chatProvider: provider }))
      .post('/api/ai/chat')
      .send({ message: 'Is this available and does it have a warranty?', context: { productId: String(unavailable._id) } });

    expect(response.status).toBe(200);
    expect(response.body.data.assistantMessage).toContain('not recorded');
    expect(response.body.data.products[0].availability).toBe('out_of_stock');
  });

  it('rejects unsafe tool arguments and exposes no private-data tool', async () => {
    const unsafe = await executeShoppingTool('searchProducts', JSON.stringify({ query: 'pan', $where: 'this.secret' }));
    expect(unsafe.output).toMatchObject({ error: { code: 'INVALID_TOOL_ARGUMENTS' } });

    const privateAttempt = await executeShoppingTool('getCustomers', JSON.stringify({ includePasswords: true }));
    expect(privateAttempt.output).toEqual({ error: { code: 'UNKNOWN_TOOL', message: 'That tool is not available.' } });
  });

  it('isolates conversation history by a server-issued guest session secret', async () => {
    const provider = new ScriptedProvider(() => finalMessage('Hello! How can I help you shop?'));
    const app = createApp({ chatProvider: provider });
    const initial = await request(app).post('/api/ai/chat').send({ message: 'Hello' });

    const stolen = await request(app)
      .post('/api/ai/chat')
      .set('x-chat-session', 'A'.repeat(43))
      .send({ conversationId: initial.body.data.conversationId, message: 'Show me that history.' });

    expect(stolen.status).toBe(404);
    expect(stolen.body.error.code).toBe('CONVERSATION_NOT_FOUND');
    expect(provider.calls).toHaveLength(1);
  });

  it('enforces tool-execution and model-call limits', async () => {
    const excessiveTools = new ScriptedProvider(() => ({
      role: 'assistant',
      content: null,
      tool_calls: Array.from({ length: 7 }, (_, index) => ({
        id: `tool-${index}`,
        type: 'function' as const,
        function: { name: 'getStorePolicies', arguments: '{}' },
      })),
    }));
    const toolLimit = await request(createApp({ chatProvider: excessiveTools }))
      .post('/api/ai/chat')
      .send({ message: 'Tell me everything.' });
    expect(toolLimit.status).toBe(502);
    expect(toolLimit.body.error.code).toBe('AI_TOOL_EXECUTION_LIMIT');

    const neverFinishes = new ScriptedProvider((_input, call) =>
      toolCall(`policy-${call}`, 'getStorePolicies', {}));
    const callLimit = await request(createApp({ chatProvider: neverFinishes }))
      .post('/api/ai/chat')
      .send({ message: 'What is your return policy?' });
    expect(callLimit.status).toBe(502);
    expect(callLimit.body.error.code).toBe('AI_MODEL_CALL_LIMIT');
    expect(neverFinishes.calls).toHaveLength(4);
  });
});

describe('OpenRouter provider failures', () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.OPENROUTER_MODEL;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'synthetic-openrouter-key-for-tests';
    process.env.OPENROUTER_MODEL = 'google/gemma-4-31b-it:free';
    resetEnvironmentForTests();
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = originalModel;
    resetEnvironmentForTests();
  });

  const input: ChatCompletionRequest = {
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxTokens: 50,
  };

  it('fails closed when the server key is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;
    resetEnvironmentForTests();
    let called = false;
    const provider = createOpenRouterProvider(async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    await expect(provider.complete(input)).rejects.toMatchObject({ status: 503, code: 'AI_CHAT_NOT_CONFIGURED' });
    expect(called).toBe(false);
  });

  it('maps provider rate limits to a safe temporary-unavailability error', async () => {
    const provider = createOpenRouterProvider(async () => new Response('{}', { status: 429 }));
    await expect(provider.complete(input)).rejects.toMatchObject({ status: 503, code: 'AI_PROVIDER_RATE_LIMITED' });
  });

  it('retries transient provider failures once and maps timeouts safely', async () => {
    let attempts = 0;
    const unavailable = createOpenRouterProvider(async () => {
      attempts += 1;
      return new Response('{}', { status: 503 });
    });
    await expect(unavailable.complete(input)).rejects.toMatchObject({ status: 503, code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(attempts).toBe(2);

    const timeout = createOpenRouterProvider(async () => {
      throw new DOMException('Timed out', 'TimeoutError');
    });
    await expect(timeout.complete(input)).rejects.toMatchObject({ status: 504, code: 'AI_PROVIDER_TIMEOUT' });
  });

  it('rejects malformed and empty provider responses', async () => {
    const malformed = createOpenRouterProvider(async () => new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(malformed.complete(input)).rejects.toMatchObject({ status: 502, code: 'AI_PROVIDER_INVALID_RESPONSE' });

    const empty = createOpenRouterProvider(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(empty.complete(input)).rejects.toMatchObject({ status: 502, code: 'AI_PROVIDER_EMPTY_RESPONSE' });
  });
});

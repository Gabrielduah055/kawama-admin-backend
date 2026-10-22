import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEFAULT_OPENROUTER_MODEL, resetEnvironmentForTests } from '../src/config/environment.js';
import { CategoryModel } from '../src/models/CategorySchema.js';
import { ChatConversationModel } from '../src/models/ChatConversationSchema.js';
import { ProductModel } from '../src/models/ProductSchema.js';
import { executeShoppingTool } from '../src/services/chat-tools.service.js';
import { createOpenRouterProvider, type ChatCompletionRequest, type ChatProvider, type ProviderMessage } from '../src/services/openrouter.service.js';
import { searchProductsToolSchema } from '../src/validation/chat.schemas.js';

let mongo: MongoMemoryServer | undefined;
let mongoDataDirectory: string | undefined;
const controlledStoreKeys = [
  'STORE_CONTACT_EMAIL',
  'STORE_CONTACT_PHONE',
  'STORE_CONTACT_WHATSAPP_URL',
  'STORE_DELIVERY_POLICY',
  'STORE_PAYMENT_POLICY',
  'STORE_RETURN_POLICY',
] as const;
const originalStoreValues = new Map(controlledStoreKeys.map((key) => [key, process.env[key]]));

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

function finalPlan(plan: Record<string, unknown>): ProviderMessage {
  return {
    role: 'assistant',
    content: JSON.stringify(plan),
  };
}

function productsFromLastTool(input: ChatCompletionRequest): Array<Record<string, unknown>> {
  const toolMessage = [...input.messages].reverse().find((message) => message.role === 'tool');
  if (!toolMessage?.content) return [];
  const parsed = JSON.parse(toolMessage.content) as { products?: Array<Record<string, unknown>> };
  return parsed.products ?? [];
}

function productsFromTool(input: ChatCompletionRequest, name: string): Array<Record<string, unknown>> {
  const toolMessage = [...input.messages].reverse().find((message) => message.role === 'tool' && message.name === name);
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
  for (const key of controlledStoreKeys) process.env[key] = '';
  resetEnvironmentForTests();
  await Promise.all([
    CategoryModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ChatConversationModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  for (const key of controlledStoreKeys) {
    const original = originalStoreValues.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  resetEnvironmentForTests();
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
      return finalPlan({
        type: 'product_answer',
        productClaims: products.map((product) => ({
          productId: String(product.id),
          pricePesewas: Number(product.pricePesewas),
          availability: product.stockLevel,
          customerBudgetPesewas: 40_000,
        })),
      });
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
        return finalPlan({
          type: 'product_answer',
          productClaims: products.map((product) => ({ productId: String(product.id), includeSummary: true })),
        });
      }
      if (!lastTool && userMessage?.includes('Compare')) {
        const system = input.messages[0]!.content ?? '';
        const ids = [...system.matchAll(/id: ([a-f\d]{24})/gi)].map((match) => match[1]!);
        return toolCall('compare', 'getProductDetails', { identifiers: ids });
      }
      const products = productsFromLastTool(input);
      return finalPlan({
        type: 'product_answer',
        productClaims: products.map((product) => ({
          productId: String(product.id),
          pricePesewas: Number(product.pricePesewas),
        })),
      });
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

  it('keeps original positions when an earlier displayed product is archived', async () => {
    const first = await seedProduct({ slug: 'position-a', name: 'Position A Blender', pricePesewas: 30_000 });
    const second = await seedProduct({ slug: 'position-b', name: 'Position B Blender', pricePesewas: 38_000 });
    const provider = new ScriptedProvider((input) => {
      const userMessage = [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const lastTool = [...input.messages].reverse().find((message) => message.role === 'tool');
      const system = input.messages[0]!.content ?? '';
      if (userMessage.includes('Show me') && !lastTool) {
        return toolCall('position-search', 'searchProducts', { query: 'blender', sort: 'price_asc', limit: 2 });
      }
      if (userMessage.includes('Show me') && lastTool) {
        const products = productsFromLastTool(input);
        return finalPlan({
          type: 'product_answer',
          productClaims: products.map((product) => ({ productId: String(product.id), includeSummary: true })),
        });
      }
      if (userMessage.includes('second') && !lastTool) {
        const secondId = /2\..*?id: ([a-f\d]{24})/i.exec(system)?.[1];
        return toolCall('position-second', 'getProductDetails', { identifiers: [secondId] });
      }
      if (userMessage.includes('second') && lastTool) {
        return finalPlan({
          type: 'product_answer',
          productClaims: [{ productId: String(second._id), availability: 'in_stock' }],
        });
      }
      return finalPlan({ type: 'unavailable_reference' });
    });
    const app = createApp({ chatProvider: provider });
    const initial = await request(app).post('/api/ai/chat').send({ message: 'Show me two blenders.' });
    expect(initial.body.data.products.map((product: { id: string }) => product.id)).toEqual([String(first._id), String(second._id)]);
    await ProductModel.findByIdAndUpdate(first._id, { status: 'archived' });

    const secondResponse = await request(app)
      .post('/api/ai/chat')
      .set('x-chat-session', String(initial.headers['x-chat-session']))
      .send({ conversationId: initial.body.data.conversationId, message: 'Tell me about the second one.' });
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body.data.products[0].id).toBe(String(second._id));

    const firstResponse = await request(app)
      .post('/api/ai/chat')
      .set('x-chat-session', String(initial.headers['x-chat-session']))
      .send({ conversationId: initial.body.data.conversationId, message: 'What about the first one?' });
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body.data.assistantMessage).toContain('no longer available');
    expect(firstResponse.body.data.products).toEqual([]);
    const finalSystem = provider.calls.at(-1)!.messages[0]!.content ?? '';
    expect(finalSystem).toContain(`1. Position A Blender (id: ${first._id}, slug: position-a, currentStatus: unavailable)`);
    expect(finalSystem).toContain(`2. Position B Blender (id: ${second._id}, slug: position-b, currentStatus: active)`);
  });

  it('distinguishes missing specifications and current unavailability', async () => {
    const unavailable = await seedProduct({ stockQuantity: 0, details: [], specifications: [] });
    const provider = new ScriptedProvider((input, call) => call === 1
      ? toolCall('details', 'getProductDetails', { identifiers: [String(unavailable._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [{ productId: String(unavailable._id), availability: 'out_of_stock', warranty: null }],
      }));
    const response = await request(createApp({ chatProvider: provider }))
      .post('/api/ai/chat')
      .send({ message: 'Is this available and does it have a warranty?', context: { productId: String(unavailable._id) } });

    expect(response.status).toBe(200);
    expect(response.body.data.assistantMessage).toContain('not recorded');
    expect(response.body.data.products[0].availability).toBe('out_of_stock');
  });

  it('does not forward invented product facts when the model skips retrieval', async () => {
    const inventedId = String(new mongoose.Types.ObjectId());
    const invented = new ScriptedProvider(() => finalPlan({
      type: 'product_answer',
      productClaims: [{
        productId: inventedId,
        pricePesewas: 29_900,
        availability: 'in_stock',
        warranty: 'Five-year warranty',
      }],
    }));
    const response = await request(createApp({ chatProvider: invented }))
      .post('/api/ai/chat')
      .send({ message: 'Recommend a blender and tell me its price and warranty.' });

    expect(response.status).toBe(200);
    expect(invented.calls).toHaveLength(2);
    expect(response.body.data.assistantMessage).toContain('could not verify current catalogue information');
    expect(response.body.data.assistantMessage).not.toContain('SuperBlend');
    expect(response.body.data.products).toEqual([]);
  });

  it('does not allow policy answers to bypass the approved policy tool', async () => {
    const invented = new ScriptedProvider(() => finalPlan({
      type: 'policy_answer',
      policyClaims: [{ topic: 'return', value: 'All returns are accepted for 90 days.' }],
    }));
    const response = await request(createApp({ chatProvider: invented }))
      .post('/api/ai/chat')
      .send({ message: 'What is your return policy?' });

    expect(response.status).toBe(200);
    expect(invented.calls).toHaveLength(2);
    expect(response.body.data.assistantMessage).toContain('could not verify the approved store information');
    expect(response.body.data.assistantMessage).not.toContain('90 days');
  });

  it('allows greetings and necessary fact-free clarification without retrieval', async () => {
    const greeting = new ScriptedProvider(() => finalPlan({ type: 'greeting' }));
    const greeted = await request(createApp({ chatProvider: greeting }))
      .post('/api/ai/chat')
      .send({ message: 'Hello' });
    expect(greeted.status).toBe(200);
    expect(greeting.calls).toHaveLength(1);

    const clarification = new ScriptedProvider(() => finalPlan({ type: 'clarification', purpose: 'budget' }));
    const clarified = await request(createApp({ chatProvider: clarification }))
      .post('/api/ai/chat')
      .send({ message: 'I need something for my kitchen.' });
    expect(clarified.status).toBe(200);
    expect(clarified.body.data.assistantMessage).toContain('What budget');
    expect(clarification.calls).toHaveLength(1);
  });

  it('accepts a policy answer only after approved policy retrieval', async () => {
    const provider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('policies', 'getStorePolicies', {})
      : finalPlan({ type: 'policy_answer', policyClaims: [{ topic: 'return', value: null }] }));
    const response = await request(createApp({ chatProvider: provider }))
      .post('/api/ai/chat')
      .send({ message: 'What is your return policy?' });
    expect(response.status).toBe(200);
    expect(response.body.data.assistantMessage).toContain('cannot confirm return terms');
    expect(provider.calls).toHaveLength(2);
  });

  it('renders constrained clarifications without forwarding factual prefixes', async () => {
    for (const inventedPrefix of [
      'This blender includes a lifetime warranty. What budget would you like?',
      'This blender has a titanium jug. What budget would you like?',
    ]) {
      const provider = new ScriptedProvider((_input, call) => call === 1
        ? finalPlan({ type: 'clarification', purpose: 'budget', assistantMessage: inventedPrefix })
        : finalPlan({ type: 'clarification', purpose: 'budget' }));
      const response = await request(createApp({ chatProvider: provider }))
        .post('/api/ai/chat')
        .send({ message: 'I need a blender.' });

      expect(response.status).toBe(200);
      expect(response.body.data.assistantMessage).toBe('What budget would you like to stay within?');
      expect(response.body.data.assistantMessage).not.toContain('lifetime warranty');
      expect(response.body.data.assistantMessage).not.toContain('titanium');
      expect(provider.calls).toHaveLength(2);
    }
  });

  it('validates policy claims against null and configured policy values', async () => {
    const nullPolicyProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('null-policy', 'getStorePolicies', {})
      : finalPlan({ type: 'policy_answer', policyClaims: [{ topic: 'return', value: 'Free returns for 90 days.' }] }));
    const nullPolicyResponse = await request(createApp({ chatProvider: nullPolicyProvider }))
      .post('/api/ai/chat')
      .send({ message: 'What are the return terms?' });
    expect(nullPolicyResponse.status).toBe(200);
    expect(nullPolicyResponse.body.data.assistantMessage).not.toContain('90 days');
    expect(nullPolicyResponse.body.data.assistantMessage).toContain('could not verify');

    process.env.STORE_RETURN_POLICY = 'Returns are accepted within 14 days with a receipt.';
    resetEnvironmentForTests();
    const contradictoryProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('configured-policy', 'getStorePolicies', {})
      : finalPlan({ type: 'policy_answer', policyClaims: [{ topic: 'return', value: 'Returns are free for 30 days.' }] }));
    const contradictoryResponse = await request(createApp({ chatProvider: contradictoryProvider }))
      .post('/api/ai/chat')
      .send({ message: 'Can I return my order?' });
    expect(contradictoryResponse.status).toBe(200);
    expect(contradictoryResponse.body.data.assistantMessage).not.toContain('30 days');

    const correctProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('correct-policy', 'getStorePolicies', {})
      : finalPlan({
        type: 'policy_answer',
        policyClaims: [{ topic: 'return', value: 'Returns are accepted within 14 days with a receipt.' }],
      }));
    const correctResponse = await request(createApp({ chatProvider: correctProvider }))
      .post('/api/ai/chat')
      .send({ message: 'Can I return my order?' });
    expect(correctResponse.status).toBe(200);
    expect(correctResponse.body.data.assistantMessage).toContain('Returns are accepted within 14 days with a receipt.');
  });

  it('keeps customer budgets separate from canonical per-product prices', async () => {
    const blender = await seedProduct({ pricePesewas: 35_000 });
    const incorrect = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('incorrect-price', 'getProductDetails', { identifiers: [String(blender._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [{
          productId: String(blender._id),
          pricePesewas: 40_000,
          customerBudgetPesewas: 40_000,
        }],
      }));
    const rejected = await request(createApp({ chatProvider: incorrect }))
      .post('/api/ai/chat')
      .send({ message: 'I need a blender under GH₵400.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.assistantMessage).not.toContain('costs GHS 400');
    expect(rejected.body.data.products).toEqual([]);

    const correct = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('correct-price', 'getProductDetails', { identifiers: [String(blender._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [{
          productId: String(blender._id),
          pricePesewas: 35_000,
          customerBudgetPesewas: 40_000,
        }],
      }));
    const accepted = await request(createApp({ chatProvider: correct }))
      .post('/api/ai/chat')
      .send({ message: 'I need a blender under GH₵400.' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.assistantMessage).toContain('costs GHS 350.00');
    expect(accepted.body.data.assistantMessage).toContain('fits your GHS 400.00 budget');
    expect(accepted.body.data.products[0].price).toBe(350);
  });

  it('supports contact, payment, return, contextual policy, and mixed intents without keyword classification', async () => {
    process.env.STORE_CONTACT_EMAIL = 'help@kawama.test';
    process.env.STORE_CONTACT_PHONE = '+233200000000';
    process.env.STORE_CONTACT_WHATSAPP_URL = 'https://wa.me/233200000000';
    process.env.STORE_DELIVERY_POLICY = 'Delivery in Accra takes two business days.';
    resetEnvironmentForTests();

    const contactProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('contact-policy', 'getStorePolicies', {})
      : finalPlan({
        type: 'policy_answer',
        policyClaims: [{
          topic: 'contact',
          email: 'help@kawama.test',
          phone: '+233200000000',
          whatsappUrl: 'https://wa.me/233200000000',
        }],
      }));
    const contact = await request(createApp({ chatProvider: contactProvider }))
      .post('/api/ai/chat')
      .send({ message: 'How can I reach you?' });
    expect(contact.status).toBe(200);
    expect(contact.body.data.assistantMessage).toContain('help@kawama.test');

    const mobileMoneyProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('mobile-money-policy', 'getStorePolicies', {})
      : finalPlan({ type: 'policy_answer', policyClaims: [{ topic: 'payment', value: null }] }));
    const mobileMoney = await request(createApp({ chatProvider: mobileMoneyProvider }))
      .post('/api/ai/chat')
      .send({ message: 'Can I pay with mobile money?' });
    expect(mobileMoney.status).toBe(200);
    expect(mobileMoney.body.data.assistantMessage).toContain('cannot confirm Mobile Money');

    const returnProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('item-return-policy', 'getStorePolicies', {})
      : finalPlan({ type: 'policy_answer', policyClaims: [{ topic: 'return', value: null }] }));
    const itemReturn = await request(createApp({ chatProvider: returnProvider }))
      .post('/api/ai/chat')
      .send({ message: 'Can I return an item?' });
    expect(itemReturn.status).toBe(200);
    expect(itemReturn.body.data.assistantMessage).toContain('cannot confirm return terms');

    const product = await seedProduct();
    const contextualPolicyProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('context-policy', 'getStorePolicies', {})
      : finalPlan({
        type: 'policy_answer',
        policyClaims: [{ topic: 'delivery', value: 'Delivery in Accra takes two business days.' }],
      }));
    const contextualPolicy = await request(createApp({ chatProvider: contextualPolicyProvider }))
      .post('/api/ai/chat')
      .send({ message: 'When will you bring it?', context: { productId: String(product._id) } });
    expect(contextualPolicy.status).toBe(200);
    expect(contextualPolicy.body.data.assistantMessage).toContain('two business days');
    expect(contextualPolicyProvider.calls).toHaveLength(2);

    const mixedProvider = new ScriptedProvider((input, call) => {
      if (call === 1) return toolCall('mixed-product', 'searchProducts', { query: 'blender', limit: 1 });
      if (call === 2) return toolCall('mixed-policy', 'getStorePolicies', {});
      const products = productsFromTool(input, 'searchProducts');
      return finalPlan({
        type: 'mixed_answer',
        productClaims: [{ productId: String(products[0]!.id), availability: products[0]!.stockLevel }],
        policyClaims: [{ topic: 'delivery', value: 'Delivery in Accra takes two business days.' }],
      });
    });
    const mixed = await request(createApp({ chatProvider: mixedProvider }))
      .post('/api/ai/chat')
      .send({ message: 'Is this blender available, and when can you bring it?' });
    expect(mixed.status).toBe(200);
    expect(mixed.body.data.assistantMessage).toContain('is in stock');
    expect(mixed.body.data.assistantMessage).toContain('two business days');
    expect(mixed.body.data.products[0].id).toBe(String(product._id));
  });

  it('binds positive and negative availability claims to each product', async () => {
    const available = await seedProduct({ slug: 'available-blender', name: 'Available Blender', stockQuantity: 5, pricePesewas: 35_000 });
    const unavailable = await seedProduct({ slug: 'unavailable-blender', name: 'Unavailable Blender', stockQuantity: 0, pricePesewas: 30_000 });

    const unavailableProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('out-stock', 'getProductDetails', { identifiers: [String(unavailable._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [{ productId: String(unavailable._id), availability: 'out_of_stock' }],
      }));
    const outOfStock = await request(createApp({ chatProvider: unavailableProvider }))
      .post('/api/ai/chat')
      .send({ message: 'Is the unavailable blender available?' });
    expect(outOfStock.status).toBe(200);
    expect(outOfStock.body.data.assistantMessage).toContain('is not in stock');
    expect(outOfStock.body.data.assistantMessage).toContain('out of stock');

    const availableProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('in-stock', 'getProductDetails', { identifiers: [String(available._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [{ productId: String(available._id), availability: 'in_stock' }],
      }));
    const inStock = await request(createApp({ chatProvider: availableProvider }))
      .post('/api/ai/chat')
      .send({ message: 'Is the available blender available?' });
    expect(inStock.body.data.assistantMessage).toContain('is in stock');

    const contradictoryProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('wrong-stock', 'getProductDetails', { identifiers: [String(unavailable._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [{ productId: String(unavailable._id), availability: 'in_stock' }],
      }));
    const contradictory = await request(createApp({ chatProvider: contradictoryProvider }))
      .post('/api/ai/chat')
      .send({ message: 'Is the unavailable blender available?' });
    expect(contradictory.status).toBe(200);
    expect(contradictory.body.data.assistantMessage).not.toContain('is in stock');

    const comparisonProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('stock-comparison', 'getProductDetails', { identifiers: [String(available._id), String(unavailable._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [
          { productId: String(available._id), availability: 'in_stock' },
          { productId: String(unavailable._id), availability: 'out_of_stock' },
        ],
      }));
    const comparison = await request(createApp({ chatProvider: comparisonProvider }))
      .post('/api/ai/chat')
      .send({ message: 'Compare availability for these two blenders.' });
    expect(comparison.status).toBe(200);
    expect(comparison.body.data.assistantMessage).toContain('Available Blender is in stock');
    expect(comparison.body.data.assistantMessage).toContain('Unavailable Blender is not in stock');
    expect(comparison.body.data.products).toHaveLength(2);
  });

  it('binds warranty and material assertions to the specific retrieved product', async () => {
    const glass = await seedProduct({
      slug: 'glass-blender',
      name: 'Glass Blender',
      specifications: [
        { label: 'Jug material', value: 'Borosilicate glass' },
        { label: 'Warranty', value: 'One year' },
      ],
    });
    const steel = await seedProduct({
      slug: 'steel-blender',
      name: 'Steel Blender',
      specifications: [
        { label: 'Jug material', value: 'Stainless steel' },
        { label: 'Warranty', value: 'Two years' },
      ],
    });
    const wrongProductFact = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('cross-product-fact', 'getProductDetails', { identifiers: [String(glass._id), String(steel._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [{ productId: String(glass._id), warranty: 'Two years', material: 'Stainless steel' }],
      }));
    const rejected = await request(createApp({ chatProvider: wrongProductFact }))
      .post('/api/ai/chat')
      .send({ message: 'What are the warranty and material for the glass blender?' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.assistantMessage).not.toContain('Two years');
    expect(rejected.body.data.assistantMessage).not.toContain('Stainless steel');

    const correctProductFact = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('correct-product-fact', 'getProductDetails', { identifiers: [String(glass._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [{ productId: String(glass._id), warranty: 'One year', material: 'Borosilicate glass' }],
      }));
    const accepted = await request(createApp({ chatProvider: correctProductFact }))
      .post('/api/ai/chat')
      .send({ message: 'What are the warranty and material for the glass blender?' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.assistantMessage).toContain('One year');
    expect(accepted.body.data.assistantMessage).toContain('Borosilicate glass');
    expect(accepted.body.data.products[0].id).toBe(String(glass._id));
  });

  it('handles formatted currency amounts without truncating malformed grouping', async () => {
    const expensive = await seedProduct({ slug: 'formatted-price', name: 'Formatted Price Blender', pricePesewas: 125_000 });
    for (const formattedBudget of ['GHS 1,250.00', 'GH₵1,250', '1250 cedis']) {
      const provider = new ScriptedProvider((_input, call) => call === 1
        ? toolCall(`formatted-${call}`, 'getProductDetails', { identifiers: [String(expensive._id)] })
        : finalPlan({
          type: 'product_answer',
          productClaims: [{
            productId: String(expensive._id),
            pricePesewas: 125_000,
            customerBudgetPesewas: 125_000,
          }],
        }));
      const response = await request(createApp({ chatProvider: provider }))
        .post('/api/ai/chat')
        .send({ message: `My budget is ${formattedBudget}.`, context: { productId: String(expensive._id) } });
      expect(response.status).toBe(200);
      expect(response.body.data.assistantMessage).toContain('GHS 1,250.00');
      expect(response.body.data.products[0].price).toBe(1250);
    }

    const precise = await seedProduct({ slug: 'precise-price', name: 'Precise Price Blender', pricePesewas: 1_999 });
    const preciseProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('precise-price', 'getProductDetails', { identifiers: [String(precise._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [{ productId: String(precise._id), pricePesewas: 1_999, customerBudgetPesewas: 1_999 }],
      }));
    const preciseResponse = await request(createApp({ chatProvider: preciseProvider }))
      .post('/api/ai/chat')
      .send({ message: 'My exact budget is GHS 19.99.', context: { productId: String(precise._id) } });
    expect(preciseResponse.body.data.assistantMessage).toContain('GHS 19.99');

    const malformedProvider = new ScriptedProvider((_input, call) => call === 1
      ? toolCall('malformed-price', 'getProductDetails', { identifiers: [String(precise._id)] })
      : finalPlan({
        type: 'product_answer',
        productClaims: [{ productId: String(precise._id), customerBudgetPesewas: 12_500 }],
      }));
    const malformedResponse = await request(createApp({ chatProvider: malformedProvider }))
      .post('/api/ai/chat')
      .send({ message: 'My budget is GHS 1,25.00.', context: { productId: String(precise._id) } });
    expect(malformedResponse.status).toBe(200);
    expect(malformedResponse.body.data.assistantMessage).not.toContain('GHS 125.00');
    expect(malformedResponse.body.data.products).toEqual([]);
  });

  it('rejects unsafe tool arguments and exposes no private-data tool', async () => {
    const unsafe = await executeShoppingTool('searchProducts', JSON.stringify({ query: 'pan', $where: 'this.secret' }));
    expect(unsafe.output).toMatchObject({ error: { code: 'INVALID_TOOL_ARGUMENTS' } });

    const privateAttempt = await executeShoppingTool('getCustomers', JSON.stringify({ includePasswords: true }));
    expect(privateAttempt.output).toEqual({ error: { code: 'UNKNOWN_TOOL', message: 'That tool is not available.' } });
  });

  it('finds an older matching product beyond the former 100-product candidate window', async () => {
    const target = await seedProduct({
      slug: 'older-citrus-press',
      name: 'Older Citrus Press',
      shortDescription: 'Manual citrus preparation.',
      description: 'A manual press for citrus fruit.',
      featured: false,
    });
    const category = await CategoryModel.findOne({ slug: 'appliances' });
    await ProductModel.insertMany(Array.from({ length: 105 }, (_, index) => ({
      slug: `new-featured-item-${index}`,
      name: `New Featured Item ${index}`,
      category: category!._id,
      shortDescription: 'An unrelated new kitchen item.',
      description: 'An unrelated product without the target keyword.',
      pricePesewas: 10_000 + index,
      stockQuantity: 5,
      lowStockThreshold: 2,
      featured: true,
      status: 'active',
    })));

    const result = await executeShoppingTool('searchProducts', JSON.stringify({ query: 'citrus', limit: 4 }));
    expect(result.products.map((product) => product.id)).toEqual([String(target._id)]);
    expect(result.output.totalMatches).toBe(1);
  });

  it('searches full descriptions, details, specifications, filters, and spelling variants', async () => {
    const appliances = await CategoryModel.create({ name: 'Appliances', slug: 'appliances', status: 'active' });
    const cookware = await CategoryModel.create({ name: 'Cookware', slug: 'cookware', status: 'active' });
    const blender = await ProductModel.create({
      slug: 'precision-blender',
      name: 'Precision Blender',
      category: appliances._id,
      shortDescription: 'A countertop appliance.',
      description: 'one two three four five six seven eight nine ten eleven twelve heatproof vessel',
      pricePesewas: 19_99,
      stockQuantity: 3,
      lowStockThreshold: 1,
      details: ['Dishwasher-safe removable lid'],
      specifications: [{ label: 'Jug material', value: 'Borosilicate glass' }],
      status: 'active',
    });
    await ProductModel.create({
      slug: 'unrelated-pan',
      name: 'Unrelated Pan',
      category: cookware._id,
      shortDescription: 'A cookware item.',
      description: 'An unrelated pan.',
      pricePesewas: 19_99,
      stockQuantity: 3,
      status: 'active',
    });

    const specification = await executeShoppingTool('searchProducts', JSON.stringify({ query: 'borosilicate', limit: 4 }));
    expect(specification.products.map((product) => product.id)).toEqual([String(blender._id)]);
    const lateDescription = await executeShoppingTool('searchProducts', JSON.stringify({ query: 'heatproof', limit: 4 }));
    expect(lateDescription.products.map((product) => product.id)).toEqual([String(blender._id)]);
    const misspelled = await executeShoppingTool('searchProducts', JSON.stringify({
      query: 'blendr', category: 'Appliances', minPrice: 19.99, maxPrice: 19.99, availability: 'in_stock', limit: 4,
    }));
    expect(misspelled.products.map((product) => product.id)).toEqual([String(blender._id)]);
    expect(misspelled.output.totalMatches).toBe(1);
  });

  it('validates decimal budgets with tolerant pesewa conversion and exact boundaries', async () => {
    for (const value of [19.99, 0.29, 35.50, 35]) {
      expect(searchProductsToolSchema.safeParse({ minPrice: value }).success).toBe(true);
    }
    for (const value of [19.999, -1, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001]) {
      expect(searchProductsToolSchema.safeParse({ minPrice: value }).success).toBe(false);
    }
    expect(searchProductsToolSchema.safeParse({ minPrice: 20, maxPrice: 19.99 }).success).toBe(false);
    const invalidTool = await executeShoppingTool('searchProducts', JSON.stringify({ minPrice: 19.999 }));
    expect(invalidTool.output).toMatchObject({ error: { code: 'INVALID_TOOL_ARGUMENTS' } });

    const exact = await seedProduct({ slug: 'exact-boundary', name: 'Exact Boundary Blender', pricePesewas: 1_999 });
    await seedProduct({ slug: 'below-boundary', name: 'Below Boundary Blender', pricePesewas: 1_998 });
    await seedProduct({ slug: 'above-boundary', name: 'Above Boundary Blender', pricePesewas: 2_000 });
    const result = await executeShoppingTool('searchProducts', JSON.stringify({ minPrice: 19.99, maxPrice: 19.99, limit: 6 }));
    expect(result.products.map((product) => product.id)).toEqual([String(exact._id)]);
  });

  it('isolates conversation history by a server-issued guest session secret', async () => {
    const provider = new ScriptedProvider(() => finalPlan({ type: 'greeting' }));
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

  it('keeps catalogue and checkout routes available when chat is disabled', async () => {
    const originalEnabled = process.env.AI_CHAT_ENABLED;
    process.env.AI_CHAT_ENABLED = 'false';
    resetEnvironmentForTests();
    try {
      await seedProduct();
      const app = createApp();
      const catalogue = await request(app).get('/api/v1/products');
      expect(catalogue.status).toBe(200);
      expect(catalogue.body.data).toHaveLength(1);

      const checkout = await request(app).post('/api/v1/checkout/sessions').send({});
      expect(checkout.status).toBe(422);
      expect(checkout.body.error.code).toBe('VALIDATION_ERROR');

      const chat = await request(app).post('/api/ai/chat').send({ message: 'Hello' });
      expect(chat.status).toBe(503);
      expect(chat.body.error.code).toBe('AI_CHAT_DISABLED');
    } finally {
      if (originalEnabled === undefined) delete process.env.AI_CHAT_ENABLED;
      else process.env.AI_CHAT_ENABLED = originalEnabled;
      resetEnvironmentForTests();
    }
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
  const originalEnabled = process.env.AI_CHAT_ENABLED;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'synthetic-openrouter-key-for-tests';
    process.env.OPENROUTER_MODEL = 'google/gemma-4-31b-it:free';
    process.env.AI_CHAT_ENABLED = 'true';
    resetEnvironmentForTests();
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = originalModel;
    if (originalEnabled === undefined) delete process.env.AI_CHAT_ENABLED;
    else process.env.AI_CHAT_ENABLED = originalEnabled;
    resetEnvironmentForTests();
  });

  const input: ChatCompletionRequest = {
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxTokens: 50,
  };

  async function requestedModel(configuredModel?: string): Promise<Record<string, unknown>> {
    if (configuredModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = configuredModel;
    resetEnvironmentForTests();
    let requestBody: Record<string, unknown> = {};
    const provider = createOpenRouterProvider(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await provider.complete(input);
    return requestBody;
  }

  it('uses Gemma by default and sends an explicitly configured model without substitution', async () => {
    const defaultRequest = await requestedModel();
    expect(defaultRequest.model).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(defaultRequest.models).toBeUndefined();

    const configuredRequest = await requestedModel('example-provider/explicit-model');
    expect(configuredRequest.model).toBe('example-provider/explicit-model');
    expect(configuredRequest.models).toBeUndefined();
  });

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

  it('does not contact OpenRouter when chat is disabled', async () => {
    process.env.AI_CHAT_ENABLED = 'false';
    resetEnvironmentForTests();
    let called = false;
    const provider = createOpenRouterProvider(async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    await expect(provider.complete(input)).rejects.toMatchObject({ status: 503, code: 'AI_CHAT_DISABLED' });
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

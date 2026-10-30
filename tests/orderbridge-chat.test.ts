import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnvironment, resetEnvironmentForTests } from '../src/config/environment.js';
import {
  buildOrderBridgeMessage,
  mapProductCards,
  runOrderBridgeShoppingChat,
} from '../src/services/orderbridge-chat.service.js';
import {
  createOrderBridgeWebsiteClient,
  type OrderBridgeWebsiteClient,
  type OrderBridgeWebsiteMessage,
  type OrderBridgeWebsiteResponse,
} from '../src/services/orderbridge-website-client.service.js';

const modelMocks = vi.hoisted(() => ({
  create: vi.fn(),
  findOne: vi.fn(),
  catalogLookup: vi.fn(),
}));

vi.mock('../src/models/OrderBridgeChatSessionSchema.js', () => ({
  OrderBridgeChatSessionModel: {
    create: modelMocks.create,
    findOne: modelMocks.findOne,
  },
}));

vi.mock('../src/services/catalog.service.js', () => ({
  getPublicProductsByIdentifiers: modelMocks.catalogLookup,
}));

const businessId = '0123456789abcdef01234567';
const upstreamConversationId = 'A'.repeat(43);
const upstreamConversationToken = `v1.${'B'.repeat(43)}`;
const integrationKey = 'website-integration-key-that-is-server-only';
const originalChatEnabled = process.env.AI_CHAT_ENABLED;
const originalTimeout = process.env.ORDERBRIDGE_CHAT_TIMEOUT_MS;

const localProduct = {
  id: '507f1f77bcf86cd799439011',
  slug: 'smoothie-blender',
  name: 'Smoothie Blender',
  price: 350,
  currency: 'GHS',
  images: [{ src: 'https://cdn.example/blender.png', alt: 'Smoothie blender' }],
  stockLevel: 'low_stock',
};

class StubOrderBridgeClient implements OrderBridgeWebsiteClient {
  public readonly calls: OrderBridgeWebsiteMessage[] = [];

  constructor(
    public readonly businessId: string,
    private readonly response: OrderBridgeWebsiteResponse,
  ) {}

  async sendMessage(input: OrderBridgeWebsiteMessage): Promise<OrderBridgeWebsiteResponse> {
    this.calls.push(input);
    return this.response;
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

function upstreamProduct(id: string, name = `Product ${id}`) {
  return {
    id,
    name,
    price: 100,
    currency: 'GHS',
    available: false,
    canonicalUrl: `https://shop.example/products/${id}`,
  };
}

function publicProduct(id: string) {
  return {
    ...localProduct,
    id,
    slug: `product-${id}`,
    name: `Product ${id}`,
  };
}

beforeEach(() => {
  process.env.AI_CHAT_ENABLED = 'true';
  delete process.env.ORDERBRIDGE_CHAT_TIMEOUT_MS;
  resetEnvironmentForTests();
  vi.clearAllMocks();
});

afterAll(() => {
  if (originalChatEnabled === undefined) delete process.env.AI_CHAT_ENABLED;
  else process.env.AI_CHAT_ENABLED = originalChatEnabled;
  if (originalTimeout === undefined) delete process.env.ORDERBRIDGE_CHAT_TIMEOUT_MS;
  else process.env.ORDERBRIDGE_CHAT_TIMEOUT_MS = originalTimeout;
  resetEnvironmentForTests();
});

describe('OrderBridge chat product mapping', () => {
  it('keeps fresh Kawama price and stock when OrderBridge data is cached', async () => {
    const response = upstreamResponse({
      data: {
        product: upstreamProduct(localProduct.id, 'Cached product name'),
        commerceDataFreshness: {
          products: [{
            productId: localProduct.id,
            price: 'cached',
            availability: 'cached',
          }],
        },
      },
    });
    const getProducts = vi.fn(async () => [localProduct]);

    const cards = await mapProductCards(response, getProducts);

    expect(cards).toEqual([expect.objectContaining({
      id: localProduct.id,
      name: 'Smoothie Blender',
      price: 350,
      availability: 'low_stock',
      url: `https://shop.example/products/${localProduct.id}`,
    })]);
  });

  it('prioritizes the explicitly selected product before the four-card limit', async () => {
    const response = upstreamResponse({
      data: {
        product: upstreamProduct('selected'),
        products: ['old-1', 'old-2', 'old-3', 'old-4'].map((id) => upstreamProduct(id)),
      },
    });
    const getProducts = vi.fn(async (identifiers: string[]) => identifiers.map(publicProduct));

    const cards = await mapProductCards(response, getProducts);

    expect(getProducts).toHaveBeenCalledWith(['selected', 'old-1', 'old-2', 'old-3']);
    expect(cards.map((card) => card.id)).toEqual(['selected', 'old-1', 'old-2', 'old-3']);
  });
});

describe('OrderBridge product-page context', () => {
  it.each([
    ['productId', { productId: localProduct.id }],
    ['productSlug', { productSlug: localProduct.slug }],
  ] as const)('forwards authoritative context resolved from %s inside the supported message field', async (_label, context) => {
    modelMocks.catalogLookup.mockResolvedValueOnce([localProduct]);
    modelMocks.create.mockResolvedValueOnce({ _id: 'local-conversation-id' });
    const client = new StubOrderBridgeClient(businessId, upstreamResponse());

    await runOrderBridgeShoppingChat({ message: 'Tell me about this.', context }, undefined, client);

    expect(modelMocks.catalogLookup).toHaveBeenCalledWith([Object.values(context)[0]]);
    expect(client.calls[0]).toEqual({
      message: [
        `Kawama catalog product page: ${localProduct.name} (product ID: ${localProduct.id}; slug: ${localProduct.slug}).`,
        'Customer message: Tell me about this.',
      ].join('\n'),
    });
  });

  it('does not forward unresolved browser context as a product fact', async () => {
    const getProducts = vi.fn(async () => []);

    const message = await buildOrderBridgeMessage({
      message: 'Tell me about this.',
      context: { productSlug: 'browser-supplied-value' },
    }, getProducts);

    expect(message).toBe('Tell me about this.');
  });
});

describe('OrderBridge chat timeout configuration', () => {
  it('defaults to 60 seconds and permits a complete AI turn up to 120 seconds', () => {
    expect(getEnvironment().ORDERBRIDGE_CHAT_TIMEOUT_MS).toBe(60_000);

    process.env.ORDERBRIDGE_CHAT_TIMEOUT_MS = '120000';
    resetEnvironmentForTests();
    expect(getEnvironment().ORDERBRIDGE_CHAT_TIMEOUT_MS).toBe(120_000);

    process.env.ORDERBRIDGE_CHAT_TIMEOUT_MS = '120001';
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow();
  });
});

describe('OrderBridge website client', () => {
  it('keeps authentication server-side and sends only the supported payload', async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestInit = init;
      return new Response(JSON.stringify(upstreamResponse()), { status: 200 });
    };
    const client = createOrderBridgeWebsiteClient({
      baseUrl: 'https://orderbridge.example',
      businessId,
      integrationKey,
      timeoutMs: 60_000,
    }, fetchImpl);

    await client.sendMessage({ message: 'Show me blenders.' });

    expect(new Headers(requestInit?.headers).get('authorization')).toBe(`Bearer ${integrationKey}`);
    expect(requestInit?.body).toBe(JSON.stringify({ message: 'Show me blenders.' }));
  });
});

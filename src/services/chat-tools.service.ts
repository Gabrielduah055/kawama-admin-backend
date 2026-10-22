import { z } from 'zod';
import { getPublicProductsByIdentifiers, searchPublicProducts, type PublicProductSort } from './catalog.service.js';
import { getApprovedStorePolicies } from './store-policy.service.js';
import {
  getProductDetailsToolSchema,
  getStorePoliciesToolSchema,
  searchProductsToolSchema,
} from '../validation/chat.schemas.js';
import type { ProviderToolDefinition } from './openrouter.service.js';

export const shoppingToolDefinitions: ProviderToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'searchProducts',
      description: 'Search Kawama active public products by keywords, category, GHS price range, availability, and sorting. Prices are Ghana cedis.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 120 },
          category: { type: 'string', minLength: 1, maxLength: 80 },
          minPrice: { type: 'number', minimum: 0 },
          maxPrice: { type: 'number', minimum: 0 },
          availability: { type: 'string', enum: ['any', 'in_stock', 'out_of_stock'] },
          sort: { type: 'string', enum: ['relevance', 'price_asc', 'price_desc', 'newest', 'name'] },
          limit: { type: 'integer', minimum: 1, maximum: 6 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getProductDetails',
      description: 'Get current public details for one to four active products by product ID or slug. Use this before comparisons and factual product answers.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['identifiers'],
        properties: {
          identifiers: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: { type: 'string', minLength: 2, maxLength: 100 },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getStorePolicies',
      description: 'Get approved checkout facts and configured delivery, payment, return, and contact information. Null means the store has not supplied that information.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  },
];

export interface ShoppingToolResult {
  output: Record<string, unknown>;
  products: Array<Record<string, unknown>>;
  evidenceKind?: 'product' | 'policy' | undefined;
  evidenceSource?: 'search' | 'details' | 'policy' | undefined;
  missingProductIdentifiers?: string[] | undefined;
}

function invalidToolArguments(error: unknown): ShoppingToolResult {
  const message = error instanceof z.ZodError
    ? error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')
    : 'Arguments must be valid JSON.';
  return {
    output: { error: { code: 'INVALID_TOOL_ARGUMENTS', message } },
    products: [],
  };
}

function parseArguments(rawArguments: string): unknown {
  if (rawArguments.length > 10_000) throw new SyntaxError('Tool arguments are too large.');
  return JSON.parse(rawArguments) as unknown;
}

export async function executeShoppingTool(name: string, rawArguments: string): Promise<ShoppingToolResult> {
  let raw: unknown;
  try {
    raw = parseArguments(rawArguments);
  } catch (error) {
    return invalidToolArguments(error);
  }

  try {
    if (name === 'searchProducts') {
      const input = searchProductsToolSchema.parse(raw);
      const sortMap: Record<typeof input.sort, PublicProductSort> = {
        relevance: 'relevance',
        price_asc: 'priceAsc',
        price_desc: 'priceDesc',
        newest: 'newest',
        name: 'name',
      };
      const result = await searchPublicProducts({
        ...(input.query ? { query: input.query } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.minPrice !== undefined ? { minPrice: input.minPrice } : {}),
        ...(input.maxPrice !== undefined ? { maxPrice: input.maxPrice } : {}),
        ...(input.availability !== 'any' ? { availability: input.availability } : {}),
        sort: sortMap[input.sort],
        page: 1,
        limit: input.limit,
      });
      return {
        output: { products: result.products, totalMatches: result.total },
        products: result.products,
        evidenceKind: 'product',
        evidenceSource: 'search',
      };
    }
    if (name === 'getProductDetails') {
      const input = getProductDetailsToolSchema.parse(raw);
      const products = await getPublicProductsByIdentifiers(input.identifiers);
      const missingIdentifiers = input.identifiers.filter((identifier) =>
        !products.some((product) => product.id === identifier || product.slug === identifier));
      return {
        output: { products, missingIdentifiers },
        products,
        evidenceKind: 'product',
        evidenceSource: 'details',
        missingProductIdentifiers: missingIdentifiers,
      };
    }
    if (name === 'getStorePolicies') {
      getStorePoliciesToolSchema.parse(raw);
      return {
        output: { policies: getApprovedStorePolicies() },
        products: [],
        evidenceKind: 'policy',
        evidenceSource: 'policy',
      };
    }
    return {
      output: { error: { code: 'UNKNOWN_TOOL', message: 'That tool is not available.' } },
      products: [],
    };
  } catch (error) {
    if (error instanceof z.ZodError) return invalidToolArguments(error);
    throw error;
  }
}

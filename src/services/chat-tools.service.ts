import { z } from 'zod';
import { toPesewas } from '../lib/catalog.js';
import { descriptionSections } from '../lib/chat.js';
import {
  getActivePublicCategoryNames,
  getPublicProductsByIdentifiers,
  searchPublicProducts,
  type PublicProductSort,
} from './catalog.service.js';
import { getApprovedStorePolicies, type StorePolicies } from './store-policy.service.js';
import {
  continueProductSearchToolSchema,
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
      name: 'continueProductSearch',
      description: 'Continue the active product search. Use mode more for other options, only this, or anything else; cheaper for lower-priced unseen options; and count for the number of matching options. This preserves the active product subject and prevents repeated cards.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['more', 'count', 'cheaper'] },
          limit: { type: 'integer', minimum: 1, maximum: 6 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getStoreOverview',
      description: 'Get Kawama’s active public catalogue categories and a few currently available products. Use only for general questions about what the store sells, not for a named product or category request.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
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

export interface ShoppingSearchContext {
  query?: string | undefined;
  category?: string | undefined;
  minPricePesewas?: number | undefined;
  maxPricePesewas?: number | undefined;
  availability: 'any' | 'in_stock' | 'out_of_stock';
  sort: 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'name';
  totalMatches: number;
  seenProductIds: string[];
}

export interface ShoppingToolResult {
  output: Record<string, unknown>;
  products: Array<Record<string, unknown>>;
  policies?: StorePolicies | undefined;
  evidenceKind?: 'product' | 'policy' | undefined;
  evidenceSource?: 'search' | 'details' | 'overview' | 'policy' | undefined;
  totalMatches?: number | undefined;
  remainingMatches?: number | undefined;
  continuationMode?: 'more' | 'count' | 'cheaper' | undefined;
  previousMatchCount?: number | undefined;
  searchContext?: ShoppingSearchContext | undefined;
  categories?: string[] | undefined;
}

export interface ShoppingToolOptions {
  excludeProductIds?: string[] | undefined;
  activeSearch?: ShoppingSearchContext | undefined;
}

const sortMap: Record<ShoppingSearchContext['sort'], PublicProductSort> = {
  relevance: 'relevance',
  price_asc: 'priceAsc',
  price_desc: 'priceDesc',
  newest: 'newest',
  name: 'name',
};

function publicSearchInput(context: ShoppingSearchContext, limit: number, excludeProductIds: string[] = []) {
  return {
    ...(context.query ? { query: context.query } : {}),
    ...(context.category ? { category: context.category } : {}),
    ...(context.minPricePesewas !== undefined ? { minPrice: context.minPricePesewas / 100 } : {}),
    ...(context.maxPricePesewas !== undefined ? { maxPrice: context.maxPricePesewas / 100 } : {}),
    ...(context.availability !== 'any' ? { availability: context.availability } : {}),
    sort: sortMap[context.sort],
    page: 1,
    limit,
    ...(excludeProductIds.length > 0 ? { excludeProductIds } : {}),
  };
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

function withEvidencePrices(products: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return products.map((product) => ({
    ...product,
    pricePesewas: toPesewas(Number(product.price)),
    descriptionSections: descriptionSections(typeof product.description === 'string' ? product.description : ''),
    ...(typeof product.compareAtPrice === 'number'
      ? { compareAtPricePesewas: toPesewas(product.compareAtPrice) }
      : {}),
  }));
}

export async function executeShoppingTool(
  name: string,
  rawArguments: string,
  options: ShoppingToolOptions = {},
): Promise<ShoppingToolResult> {
  let raw: unknown;
  try {
    raw = parseArguments(rawArguments);
  } catch (error) {
    return invalidToolArguments(error);
  }

  try {
    if (name === 'searchProducts') {
      const input = searchProductsToolSchema.parse(raw);
      const result = await searchPublicProducts({
        ...(input.query ? { query: input.query } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.minPrice !== undefined ? { minPrice: input.minPrice } : {}),
        ...(input.maxPrice !== undefined ? { maxPrice: input.maxPrice } : {}),
        ...(input.availability !== 'any' ? { availability: input.availability } : {}),
        sort: sortMap[input.sort],
        page: 1,
        limit: input.limit,
        ...(options.excludeProductIds?.length ? { excludeProductIds: options.excludeProductIds } : {}),
      });
      const products = withEvidencePrices(result.products);
      const searchContext: ShoppingSearchContext = {
        ...(input.query ? { query: input.query } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.minPrice !== undefined ? { minPricePesewas: toPesewas(input.minPrice) } : {}),
        ...(input.maxPrice !== undefined ? { maxPricePesewas: toPesewas(input.maxPrice) } : {}),
        availability: input.availability,
        sort: input.sort,
        totalMatches: result.total,
        seenProductIds: [],
      };
      return {
        output: { products, totalMatches: result.total, searchContext },
        products,
        evidenceKind: 'product',
        evidenceSource: 'search',
        totalMatches: result.total,
        searchContext,
      };
    }
    if (name === 'continueProductSearch') {
      const input = continueProductSearchToolSchema.parse(raw);
      const activeSearch = options.activeSearch;
      if (!activeSearch) {
        return {
          output: {
            error: {
              code: 'NO_ACTIVE_PRODUCT_SEARCH',
              message: 'There is no active product search to continue. Start a new product search.',
            },
          },
          products: [],
        };
      }
      let continuationContext = activeSearch;
      if (input.mode === 'cheaper') {
        const shownProducts = withEvidencePrices(await getPublicProductsByIdentifiers(activeSearch.seenProductIds));
        const currentLowestPrice = shownProducts.reduce<number | undefined>((lowest, product) => {
          const price = typeof product.pricePesewas === 'number' ? product.pricePesewas : undefined;
          if (price === undefined) return lowest;
          return lowest === undefined ? price : Math.min(lowest, price);
        }, undefined);
        if (currentLowestPrice === undefined || currentLowestPrice <= 0) {
          return {
            output: {
              error: {
                code: 'NO_ACTIVE_REFERENCE_PRICE',
                message: 'No current displayed product price is available for a cheaper-options search.',
              },
            },
            products: [],
          };
        }
        continuationContext = {
          ...activeSearch,
          maxPricePesewas: Math.min(activeSearch.maxPricePesewas ?? currentLowestPrice - 1, currentLowestPrice - 1),
          sort: 'price_desc',
        };
      }
      const fullResultPromise = searchPublicProducts(publicSearchInput(continuationContext, Math.min(input.limit, 4)));
      const selectedResultPromise = input.mode === 'more' || input.mode === 'cheaper'
        ? searchPublicProducts(publicSearchInput(continuationContext, input.limit, activeSearch.seenProductIds))
        : fullResultPromise;
      const [fullResult, selectedResult] = await Promise.all([fullResultPromise, selectedResultPromise]);
      const products = withEvidencePrices(selectedResult.products);
      const remainingMatches = input.mode === 'more' || input.mode === 'cheaper'
        ? selectedResult.total
        : Math.max(0, fullResult.total - activeSearch.seenProductIds.length);
      const searchContext: ShoppingSearchContext = {
        ...continuationContext,
        totalMatches: fullResult.total,
        seenProductIds: activeSearch.seenProductIds,
      };
      return {
        output: {
          mode: input.mode,
          products,
          totalMatches: fullResult.total,
          remainingMatches,
          searchContext,
        },
        products,
        evidenceKind: 'product',
        evidenceSource: 'search',
        totalMatches: fullResult.total,
        remainingMatches,
        continuationMode: input.mode,
        previousMatchCount: activeSearch.totalMatches,
        searchContext,
      };
    }
    if (name === 'getStoreOverview') {
      getStorePoliciesToolSchema.parse(raw);
      const [categories, catalogue] = await Promise.all([
        getActivePublicCategoryNames(),
        searchPublicProducts({ availability: 'in_stock', sort: 'featured', page: 1, limit: 4 }),
      ]);
      const products = withEvidencePrices(catalogue.products);
      return {
        output: { categories, products, totalActiveProducts: catalogue.total },
        products,
        evidenceKind: 'product',
        evidenceSource: 'overview',
        totalMatches: catalogue.total,
        categories,
      };
    }
    if (name === 'getProductDetails') {
      const input = getProductDetailsToolSchema.parse(raw);
      const products = withEvidencePrices(await getPublicProductsByIdentifiers(input.identifiers));
      const missingIdentifiers = input.identifiers.filter((identifier) =>
        !products.some((product) => product.id === identifier || product.slug === identifier));
      return {
        output: { products, missingIdentifiers },
        products,
        evidenceKind: 'product',
        evidenceSource: 'details',
      };
    }
    if (name === 'getStorePolicies') {
      getStorePoliciesToolSchema.parse(raw);
      const policies = getApprovedStorePolicies();
      return {
        output: { policies },
        products: [],
        policies,
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

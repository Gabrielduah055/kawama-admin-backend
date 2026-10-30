import { getEnvironment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';
import {
  getPublicProductAvailabilityByIdentifiers,
  getPublicProductsByIdentifiers,
  searchPublicProducts,
  type PublicProductSort,
} from './catalog.service.js';
import { getApprovedStorePolicies } from './store-policy.service.js';

export interface OrderBridgeProductSearchInput {
  query?: string | undefined;
  limit: number;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  category?: string | undefined;
  available?: boolean | undefined;
  preferences: string[];
  sort: 'relevance' | 'price_asc' | 'price_desc';
}

interface OrderBridgeProduct {
  id: string;
  name: string;
  description?: string | undefined;
  price: number;
  currency: 'GHS';
  available: boolean;
  stockQuantity?: number | undefined;
  specifications?: Record<string, string | number | boolean> | undefined;
  canonicalUrl: string;
}

const orderBridgeSorts: Record<OrderBridgeProductSearchInput['sort'], PublicProductSort> = {
  relevance: 'relevance',
  price_asc: 'priceAsc',
  price_desc: 'priceDesc',
};

function canonicalProductUrl(slug: string): string {
  const template = getEnvironment().STOREFRONT_PRODUCT_URL_TEMPLATE;
  if (!template?.includes('{slug}')) {
    throw new AppError(
      503,
      'ORDERBRIDGE_INTEGRATION_NOT_CONFIGURED',
      'The OrderBridge catalog integration is not configured.',
    );
  }

  try {
    const url = new URL(template.replace('{slug}', encodeURIComponent(slug)));
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe product URL.');
    return url.toString();
  } catch {
    throw new AppError(
      503,
      'ORDERBRIDGE_INTEGRATION_NOT_CONFIGURED',
      'The OrderBridge catalog integration is not configured.',
    );
  }
}

function mapSpecifications(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const { label, value: specificationValue } = item as { label?: unknown; value?: unknown };
    if (typeof label !== 'string' || !['string', 'number', 'boolean'].includes(typeof specificationValue)) return [];
    return [[label, specificationValue as string | number | boolean] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toOrderBridgeProduct(
  product: Record<string, unknown>,
  stockQuantity?: number,
): OrderBridgeProduct {
  const description = typeof product.description === 'string'
    ? product.description.trim().slice(0, 4_000)
    : undefined;
  const specifications = mapSpecifications(product.specifications);
  const available = stockQuantity === undefined ? product.inStock === true : stockQuantity > 0;
  return {
    id: String(product.id),
    name: String(product.name),
    ...(description !== undefined ? { description } : {}),
    price: Number(product.price),
    currency: 'GHS',
    available,
    ...(stockQuantity !== undefined ? { stockQuantity } : {}),
    ...(specifications ? { specifications } : {}),
    canonicalUrl: canonicalProductUrl(String(product.slug)),
  };
}

export async function searchOrderBridgeProducts(input: OrderBridgeProductSearchInput) {
  const searchText = [input.query, ...input.preferences].filter(Boolean).join(' ');
  const result = await searchPublicProducts({
    ...(searchText ? { query: searchText } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.minPrice !== undefined ? { minPrice: input.minPrice } : {}),
    ...(input.maxPrice !== undefined ? { maxPrice: input.maxPrice } : {}),
    ...(input.available !== undefined ? { availability: input.available ? 'in_stock' : 'out_of_stock' } : {}),
    sort: orderBridgeSorts[input.sort],
    page: 1,
    limit: input.limit,
  });
  const availability = await getPublicProductAvailabilityByIdentifiers(
    result.products.map((product) => String(product.id)),
  );
  return {
    products: result.products.map((product) =>
      toOrderBridgeProduct(product, availability.get(String(product.id))?.stockQuantity)),
    total: result.total,
  };
}

export async function getOrderBridgeProduct(productId: string): Promise<{ product: OrderBridgeProduct }> {
  const [products, availability] = await Promise.all([
    getPublicProductsByIdentifiers([productId]),
    getPublicProductAvailabilityByIdentifiers([productId]),
  ]);
  const product = products[0];
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  return { product: toOrderBridgeProduct(product, availability.get(productId)?.stockQuantity) };
}

export async function getOrderBridgeProductAvailability(productId: string) {
  const product = (await getPublicProductAvailabilityByIdentifiers([productId])).get(productId);
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  return product;
}

export function getOrderBridgePolicies(topic?: string) {
  const approved = getApprovedStorePolicies();
  const policies = [
    { name: 'Delivery', content: approved.deliveryPolicy },
    { name: 'Payment', content: approved.paymentPolicy },
    { name: 'Returns', content: approved.returnPolicy },
  ].flatMap((policy) => policy.content ? [{ name: policy.name, content: policy.content }] : []);
  const normalizedTopic = topic?.trim().toLowerCase();
  return {
    policies: normalizedTopic
      ? policies.filter((policy) => `${policy.name} ${policy.content}`.toLowerCase().includes(normalizedTopic))
      : policies,
  };
}

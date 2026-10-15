import { AppError } from '../errors/AppError.js';

export type StockLevel = 'in_stock' | 'low_stock' | 'out_of_stock';

export function toPesewas(amount: number): number {
  const pesewas = Math.round(amount * 100);
  if (!Number.isFinite(amount) || Math.abs(pesewas / 100 - amount) > 1e-8) {
    throw new AppError(400, 'INVALID_PRICE', 'Prices must contain at most two decimal places.');
  }
  return pesewas;
}

export function fromPesewas(amount: number | undefined): number | undefined {
  return amount === undefined ? undefined : amount / 100;
}

export function deriveStock(stockQuantity: number, lowStockThreshold: number): {
  inStock: boolean;
  stockLevel: StockLevel;
} {
  if (stockQuantity <= 0) return { inStock: false, stockLevel: 'out_of_stock' };
  if (stockQuantity <= lowStockThreshold) return { inStock: true, stockLevel: 'low_stock' };
  return { inStock: true, stockLevel: 'in_stock' };
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toPublicProduct(product: Record<string, any>): Record<string, unknown> {
  const category = product.category ?? {};
  const complementaryCategories = Array.isArray(product.complementaryCategories)
    ? product.complementaryCategories.map((item: any) => item.name).filter(Boolean)
    : [];
  const availableQuantity = Math.max(0, product.stockQuantity - (product.reservedQuantity ?? 0));
  const stock = deriveStock(availableQuantity, product.lowStockThreshold);
  const dto: Record<string, unknown> = {
    id: String(product._id),
    slug: product.slug,
    name: product.name,
    category: category.name,
    categorySlug: category.slug,
    shortDescription: product.shortDescription,
    description: product.description,
    price: fromPesewas(product.pricePesewas),
    currency: 'GHS',
    images: [...(product.images ?? [])]
      .sort((first: any, second: any) => first.position - second.position)
      .map((image: any) => ({ src: image.src, alt: image.alt })),
    ...stock,
    featured: product.featured,
    isNew: product.newArrival,
    isBestSeller: product.isBestSeller,
    complementaryCategories,
    details: product.details ?? [],
    specifications: product.specifications ?? [],
  };
  const compareAtPrice = fromPesewas(product.compareAtPricePesewas);
  if (compareAtPrice !== undefined) dto.compareAtPrice = compareAtPrice;
  return dto;
}

export function toAdminProduct(product: Record<string, any>): Record<string, unknown> {
  return {
    ...toPublicProduct(product),
    categoryId: String(product.category?._id ?? product.category),
    complementaryCategoryIds: (product.complementaryCategories ?? []).map((item: any) =>
      String(item._id ?? item),
    ),
    images: product.images ?? [],
    stockQuantity: product.stockQuantity,
    reservedQuantity: product.reservedQuantity ?? 0,
    availableQuantity: Math.max(0, product.stockQuantity - (product.reservedQuantity ?? 0)),
    lowStockThreshold: product.lowStockThreshold,
    status: product.status,
    updatedBy: product.updatedBy,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

import mongoose from 'mongoose';
import { escapeRegex, slugify, toPublicProduct } from '../lib/catalog.js';
import { CategoryModel } from '../models/CategorySchema.js';
import { ProductModel } from '../models/ProductSchema.js';

const { Types } = mongoose;

export const publicProductSorts = ['featured', 'newest', 'name', 'priceAsc', 'priceDesc', 'relevance'] as const;
export type PublicProductSort = (typeof publicProductSorts)[number];

export interface PublicProductSearchInput {
  query?: string | undefined;
  category?: string | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  availability?: 'any' | 'in_stock' | 'out_of_stock' | undefined;
  featured?: boolean | undefined;
  sort?: PublicProductSort | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface PublicProductSearchResult {
  products: Array<Record<string, unknown>>;
  total: number;
}

function normalizeWords(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .slice(0, 10);
}

function editDistance(first: string, second: string): number {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row += 1) {
    let diagonal = previous[0]!;
    previous[0] = row;
    for (let column = 1; column <= second.length; column += 1) {
      const above = previous[column]!;
      previous[column] = Math.min(
        previous[column]! + 1,
        previous[column - 1]! + 1,
        diagonal + (first[row - 1] === second[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[second.length]!;
}

function wordMatches(queryWord: string, candidateWord: string): boolean {
  if (candidateWord.includes(queryWord) || queryWord.includes(candidateWord)) return true;
  const allowedDistance = queryWord.length >= 7 ? 2 : queryWord.length >= 4 ? 1 : 0;
  return allowedDistance > 0 && editDistance(queryWord, candidateWord) <= allowedDistance;
}

function productSearchText(product: Record<string, any>): string[] {
  return normalizeWords([
    product.name,
    product.shortDescription,
    product.description,
    ...(product.details ?? []),
    ...(product.specifications ?? []).flatMap((item: { label?: string; value?: string }) => [item.label, item.value]),
  ].filter(Boolean).join(' '));
}

function relevanceScore(product: Record<string, any>, queryWords: string[]): number {
  const candidateWords = productSearchText(product);
  return queryWords.reduce((score, queryWord) => {
    if (candidateWords.includes(queryWord)) return score + 4;
    if (candidateWords.some((candidate) => candidate.startsWith(queryWord) || queryWord.startsWith(candidate))) return score + 2;
    return candidateWords.some((candidate) => wordMatches(queryWord, candidate)) ? score + 1 : score;
  }, 0);
}

async function resolveCategoryId(value: string | undefined): Promise<unknown | undefined> {
  const category = value?.trim();
  if (!category) return undefined;
  const exactName = new RegExp(`^${escapeRegex(category)}$`, 'i');
  const found = await CategoryModel.findOne({
    status: 'active',
    $or: [{ slug: slugify(category) }, { name: exactName }],
  }).select('_id').lean();
  return found?._id;
}

function buildBaseFilter(input: PublicProductSearchInput, categoryId: unknown | undefined): Record<string, unknown> {
  const filter: Record<string, any> = { status: 'active' };
  if (categoryId !== undefined) filter.category = categoryId;
  if (input.featured !== undefined) filter.featured = input.featured;
  if (input.minPrice !== undefined || input.maxPrice !== undefined) {
    filter.pricePesewas = {
      ...(input.minPrice !== undefined ? { $gte: Math.round(input.minPrice * 100) } : {}),
      ...(input.maxPrice !== undefined ? { $lte: Math.round(input.maxPrice * 100) } : {}),
    };
  }
  if (input.availability === 'in_stock') {
    filter.$expr = { $gt: [{ $subtract: ['$stockQuantity', { $ifNull: ['$reservedQuantity', 0] }] }, 0] };
  } else if (input.availability === 'out_of_stock') {
    filter.$expr = { $lte: [{ $subtract: ['$stockQuantity', { $ifNull: ['$reservedQuantity', 0] }] }, 0] };
  }
  return filter;
}

const mongoSorts: Record<Exclude<PublicProductSort, 'relevance'>, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  name: { name: 1 },
  priceAsc: { pricePesewas: 1 },
  priceDesc: { pricePesewas: -1 },
  featured: { featured: -1, createdAt: -1 },
};

export async function searchPublicProducts(input: PublicProductSearchInput): Promise<PublicProductSearchResult> {
  const page = input.page ?? 1;
  const limit = input.limit ?? 24;
  const categoryId = await resolveCategoryId(input.category);
  if (input.category?.trim() && categoryId === undefined) return { products: [], total: 0 };

  const baseFilter = buildBaseFilter(input, categoryId);
  const queryWords = input.query ? normalizeWords(input.query) : [];
  const selectedSort = input.sort ?? (queryWords.length > 0 ? 'relevance' : 'featured');

  if (queryWords.length === 0) {
    const sort = selectedSort === 'relevance' ? mongoSorts.featured : mongoSorts[selectedSort];
    const [products, total] = await Promise.all([
      ProductModel.find(baseFilter)
        .populate('category', 'name slug')
        .populate('complementaryCategories', 'name slug')
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ProductModel.countDocuments(baseFilter),
    ]);
    return {
      products: products.map((product) => toPublicProduct(product as Record<string, any>)),
      total,
    };
  }

  // The candidate set is bounded before application-level fuzzy matching. This
  // supports ordinary misspellings without accepting model-provided regexes.
  const candidates = await ProductModel.find(baseFilter)
    .populate('category', 'name slug')
    .populate('complementaryCategories', 'name slug')
    .sort({ featured: -1, createdAt: -1 })
    .limit(100)
    .lean();
  const ranked = candidates
    .map((product) => ({ product, score: relevanceScore(product as Record<string, any>, queryWords) }))
    .filter(({ score }) => score >= Math.max(1, queryWords.length))
    .sort((first, second) => {
      if (selectedSort === 'priceAsc') return first.product.pricePesewas - second.product.pricePesewas;
      if (selectedSort === 'priceDesc') return second.product.pricePesewas - first.product.pricePesewas;
      if (selectedSort === 'name') return first.product.name.localeCompare(second.product.name);
      if (selectedSort === 'newest') return Number(second.product.createdAt) - Number(first.product.createdAt);
      return second.score - first.score || Number(second.product.featured) - Number(first.product.featured);
    });
  return {
    products: ranked.slice((page - 1) * limit, page * limit).map(({ product }) =>
      toPublicProduct(product as Record<string, any>)),
    total: ranked.length,
  };
}

export async function getPublicProductsByIdentifiers(identifiers: string[]): Promise<Array<Record<string, unknown>>> {
  const objectIds = identifiers.filter((identifier) => Types.ObjectId.isValid(identifier)).map((identifier) => new Types.ObjectId(identifier));
  const slugs = identifiers.filter((identifier) => !Types.ObjectId.isValid(identifier));
  const products = await ProductModel.find({
    status: 'active',
    $or: [
      ...(objectIds.length > 0 ? [{ _id: { $in: objectIds } }] : []),
      ...(slugs.length > 0 ? [{ slug: { $in: slugs } }] : []),
    ],
  })
    .populate('category', 'name slug')
    .populate('complementaryCategories', 'name slug')
    .lean();
  const mapped = new Map<string, Record<string, unknown>>();
  products.forEach((product) => {
    const dto = toPublicProduct(product as Record<string, any>);
    mapped.set(String(dto.id), dto);
    mapped.set(String(dto.slug), dto);
  });
  return identifiers.flatMap((identifier) => {
    const product = mapped.get(identifier);
    return product ? [product] : [];
  });
}

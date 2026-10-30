import mongoose from 'mongoose';
import { escapeRegex, slugify, toPesewas, toPublicProduct } from '../lib/catalog.js';
import { CategoryModel } from '../models/CategorySchema.js';
import { ProductModel } from '../models/ProductSchema.js';

const { Types } = mongoose;

export const publicProductSorts = ['featured', 'newest', 'name', 'priceAsc', 'priceDesc', 'relevance'] as const;
export type PublicProductSort = (typeof publicProductSorts)[number];

export interface PublicProductSearchInput {
  query?: string | undefined;
  anyQueries?: string[] | undefined;
  category?: string | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  availability?: 'any' | 'in_stock' | 'out_of_stock' | undefined;
  featured?: boolean | undefined;
  sort?: PublicProductSort | undefined;
  page?: number | undefined;
  limit?: number | undefined;
  excludeProductIds?: string[] | undefined;
}

export interface PublicProductSearchResult {
  products: Array<Record<string, unknown>>;
  total: number;
}

export interface PublicProductAvailability {
  productId: string;
  available: boolean;
  stockQuantity: number;
}

function normalizeQueryWords(value: string): string[] {
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

const searchableProductFields = [
  'name',
  'shortDescription',
  'description',
  'details',
  'specifications.label',
  'specifications.value',
] as const;

function fieldsMatching(expression: RegExp): Record<string, unknown> {
  return { $or: searchableProductFields.map((field) => ({ [field]: expression })) };
}

function exactKeywordFilter(words: string[]): Record<string, unknown> {
  return {
    $and: words.map((word) => fieldsMatching(new RegExp(escapeRegex(word), 'i'))),
  };
}

function fuzzyWordExpression(word: string): RegExp | undefined {
  if (word.length < 4) return undefined;
  const alternatives = new Set<string>([escapeRegex(word)]);
  for (let index = 0; index <= word.length; index += 1) {
    const before = escapeRegex(word.slice(0, index));
    const after = escapeRegex(word.slice(index));
    // One extra character in the stored word (for example blendr -> blender).
    alternatives.add(`${before}[a-z0-9]${after}`);
    if (index < word.length) {
      // One extra or wrong character in the query.
      alternatives.add(`${before}${escapeRegex(word.slice(index + 1))}`);
      alternatives.add(`${before}[a-z0-9]${escapeRegex(word.slice(index + 1))}`);
    }
    if (index < word.length - 1) {
      alternatives.add(
        `${before}${escapeRegex(word[index + 1]!)}${escapeRegex(word[index]!)}${escapeRegex(word.slice(index + 2))}`,
      );
    }
  }
  return new RegExp(`\\b(?:${[...alternatives].join('|')})\\b`, 'i');
}

function fuzzyKeywordFilter(words: string[]): Record<string, unknown> | undefined {
  const expressions = words.map(fuzzyWordExpression);
  if (expressions.some((expression) => expression === undefined)) return undefined;
  return { $and: expressions.map((expression) => fieldsMatching(expression!)) };
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
  const excludedIds = (input.excludeProductIds ?? [])
    .filter((identifier) => Types.ObjectId.isValid(identifier))
    .map((identifier) => new Types.ObjectId(identifier));
  if (excludedIds.length > 0) filter._id = { $nin: excludedIds };
  if (categoryId !== undefined) filter.category = categoryId;
  if (input.featured !== undefined) filter.featured = input.featured;
  if (input.minPrice !== undefined || input.maxPrice !== undefined) {
    filter.pricePesewas = {
      ...(input.minPrice !== undefined ? { $gte: toPesewas(input.minPrice) } : {}),
      ...(input.maxPrice !== undefined ? { $lte: toPesewas(input.maxPrice) } : {}),
    };
  }
  if (input.availability === 'in_stock') {
    filter.$expr = { $gt: [{ $subtract: ['$stockQuantity', { $ifNull: ['$reservedQuantity', 0] }] }, 0] };
  } else if (input.availability === 'out_of_stock') {
    filter.$expr = { $lte: [{ $subtract: ['$stockQuantity', { $ifNull: ['$reservedQuantity', 0] }] }, 0] };
  }
  return filter;
}

export async function getActivePublicCategoryNames(limit = 8): Promise<string[]> {
  const categoryIds = await ProductModel.distinct('category', { status: 'active' });
  if (categoryIds.length === 0) return [];
  const categories = await CategoryModel.find({
    _id: { $in: categoryIds },
    status: 'active',
  })
    .select('name')
    .sort({ name: 1 })
    .limit(limit)
    .lean();
  return categories
    .map((category) => category.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
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
  const queryGroups = input.query
    ? [normalizeQueryWords(input.query)]
    : (input.anyQueries ?? []).map(normalizeQueryWords).filter((words) => words.length > 0);
  const hasKeywordInput = Boolean(input.query?.trim()) || (input.anyQueries ?? []).some((query) => query.trim());
  if (hasKeywordInput && queryGroups.length === 0) return { products: [], total: 0 };
  const selectedSort = input.sort ?? (queryGroups.length > 0 ? 'relevance' : 'featured');

  if (queryGroups.length === 0) {
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

  const sort = selectedSort === 'relevance' ? mongoSorts.featured : mongoSorts[selectedSort];
  if (!input.query) {
    const preferenceFilters = await Promise.all(queryGroups.map(async (words) => {
      const exactKeyword = exactKeywordFilter(words);
      const exactTotal = await ProductModel.countDocuments({ ...baseFilter, ...exactKeyword });
      return exactTotal > 0 ? exactKeyword : fuzzyKeywordFilter(words) ?? exactKeyword;
    }));
    const preferenceFilter = preferenceFilters.length === 1
      ? preferenceFilters[0]!
      : { $or: preferenceFilters };
    const selectedFilter = { ...baseFilter, ...preferenceFilter };
    const [products, total] = await Promise.all([
      ProductModel.find(selectedFilter)
        .populate('category', 'name slug')
        .populate('complementaryCategories', 'name slug')
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ProductModel.countDocuments(selectedFilter),
    ]);
    return {
      products: products.map((product) => toPublicProduct(product as Record<string, any>)),
      total,
    };
  }

  const queryWords = queryGroups[0]!;
  const exactFilter = { ...baseFilter, ...exactKeywordFilter(queryWords) };
  const exactTotal = await ProductModel.countDocuments(exactFilter);
  const fuzzyKeyword = exactTotal === 0 ? fuzzyKeywordFilter(queryWords) : undefined;
  const fuzzyFilter = fuzzyKeyword ? { ...baseFilter, ...fuzzyKeyword } : undefined;
  const selectedFilter = exactTotal > 0 || !fuzzyFilter
    ? exactFilter
    : fuzzyFilter;
  const total = exactTotal > 0 || !fuzzyFilter
    ? exactTotal
    : await ProductModel.countDocuments(selectedFilter);
  const products = await ProductModel.find(selectedFilter)
    .populate('category', 'name slug')
    .populate('complementaryCategories', 'name slug')
    .sort(sort)
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  return {
    products: products.map((product) => toPublicProduct(product as Record<string, any>)),
    total,
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

export async function getPublicProductAvailabilityByIdentifiers(
  identifiers: string[],
): Promise<Map<string, PublicProductAvailability>> {
  const objectIds = identifiers
    .filter((identifier) => Types.ObjectId.isValid(identifier))
    .map((identifier) => new Types.ObjectId(identifier));
  if (objectIds.length === 0) return new Map();

  const products = await ProductModel.find({ _id: { $in: objectIds }, status: 'active' })
    .select('_id stockQuantity reservedQuantity')
    .lean();
  return new Map(products.map((product) => {
    const stockQuantity = Math.max(0, product.stockQuantity - (product.reservedQuantity ?? 0));
    const productId = String(product._id);
    return [productId, { productId, available: stockQuantity > 0, stockQuantity }];
  }));
}

import mongoose from 'mongoose';
import { CategoryModel } from '../models/CategorySchema.js';
import { ProductModel } from '../models/ProductSchema.js';
import { AppError } from '../errors/AppError.js';
import { toPesewas } from '../lib/catalog.js';

const { Types } = mongoose;

export interface ProductInput {
  name: string;
  categoryId: string;
  shortDescription: string;
  description: string;
  price: number;
  compareAtPrice?: number | undefined;
  images: Array<{ publicId?: string | undefined; src: string; alt: string; position: number }>;
  stockQuantity: number;
  lowStockThreshold: number;
  featured: boolean;
  isNew: boolean;
  isBestSeller: boolean;
  complementaryCategoryIds: string[];
  details: string[];
  specifications: Array<{ label: string; value: string }>;
  status: 'draft' | 'active';
}

export async function assertCategories(categoryId: string, complementaryIds: string[], activeProduct: boolean): Promise<void> {
  const requestedIds = [...new Set([categoryId, ...complementaryIds])];
  const categories = await CategoryModel.find({ _id: { $in: requestedIds } }).lean();
  if (categories.length !== requestedIds.length) {
    throw new AppError(400, 'INVALID_CATEGORY', 'One or more selected categories do not exist.');
  }
  const primary = categories.find((category: any) => String(category._id) === categoryId);
  if (activeProduct && primary?.status !== 'active') {
    throw new AppError(400, 'INACTIVE_CATEGORY', 'An active product must use an active category.');
  }
}

export function toProductPersistence(input: ProductInput): Record<string, unknown> {
  return {
    name: input.name,
    category: new Types.ObjectId(input.categoryId),
    shortDescription: input.shortDescription,
    description: input.description,
    pricePesewas: toPesewas(input.price),
    compareAtPricePesewas: input.compareAtPrice === undefined ? undefined : toPesewas(input.compareAtPrice),
    images: input.images,
    stockQuantity: input.stockQuantity,
    lowStockThreshold: input.lowStockThreshold,
    featured: input.featured,
    newArrival: input.isNew,
    isBestSeller: input.isBestSeller,
    complementaryCategories: input.complementaryCategoryIds.map((id) => new Types.ObjectId(id)),
    details: input.details,
    specifications: input.specifications,
    status: input.status,
  };
}

export async function loadPopulatedProduct(id: string): Promise<Record<string, any>> {
  const product = await ProductModel.findById(id)
    .populate('category', 'name slug status')
    .populate('complementaryCategories', 'name slug')
    .lean();
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'The product was not found.');
  return product as Record<string, any>;
}

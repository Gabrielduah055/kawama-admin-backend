import type { RequestHandler } from 'express';
import { getEnvironment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';
import { escapeRegex, fromPesewas, toAdminProduct, toPublicProduct } from '../lib/catalog.js';
import { CategoryModel } from '../models/CategorySchema.js';
import { ProductModel } from '../models/ProductSchema.js';
import { assertCategories, loadPopulatedProduct, toProductPersistence } from '../services/product.service.js';
import { objectIdSchema, paginationSchema, productCreateSchema, productUpdateSchema } from '../validation/schemas.js';

function assertManagedImages(images: Array<{ publicId?: string | undefined }>): void {
  const prefix = `${getEnvironment().CLOUDINARY_FOLDER}/`;
  if (images.some((image) => !image.publicId?.startsWith(prefix))) {
    throw new AppError(400, 'INVALID_MEDIA_ASSET', 'Product images must be uploaded to the Kawama Cloudinary folder.');
  }
}

export const getPublicProducts: RequestHandler = async (request, response) => {
  const { page, limit } = paginationSchema.parse(request.query);
  const filter: Record<string, unknown> = { status: 'active' };
  const categorySlug = typeof request.query.category === 'string' ? request.query.category.trim() : '';
  if (categorySlug) {
    const category = await CategoryModel.findOne({ slug: categorySlug, status: 'active' }).select('_id').lean();
    if (!category) {
      response.status(200).json({ message: 'Products fetched successfully', data: [], meta: { page, limit, total: 0 } });
      return;
    }
    filter.category = category._id;
  }
  if (request.query.featured === 'true') filter.featured = true;
  if (request.query.inStock === 'true') filter.stockQuantity = { $gt: 0 };
  if (request.query.inStock === 'false') filter.stockQuantity = 0;
  const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (query) {
    const expression = new RegExp(escapeRegex(query), 'i');
    filter.$or = [{ name: expression }, { shortDescription: expression }, { description: expression }];
  }

  const sorts: Record<string, Record<string, 1 | -1>> = {
    newest: { createdAt: -1 },
    name: { name: 1 },
    priceAsc: { pricePesewas: 1 },
    priceDesc: { pricePesewas: -1 },
    featured: { featured: -1, createdAt: -1 },
  };
  const sortKey = typeof request.query.sort === 'string' ? request.query.sort : 'featured';
  const sort = sorts[sortKey] ?? sorts.featured!;
  const [products, total] = await Promise.all([
    ProductModel.find(filter)
      .populate('category', 'name slug')
      .populate('complementaryCategories', 'name slug')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ProductModel.countDocuments(filter),
  ]);
  response.status(200).json({
    message: 'Products fetched successfully',
    data: products.map((product) => toPublicProduct(product as Record<string, any>)),
    meta: { page, limit, total },
  });
};

export const getPublicProductBySlug: RequestHandler = async (request, response) => {
  const product = await ProductModel.findOne({ slug: request.params.slug, status: 'active' })
    .populate('category', 'name slug')
    .populate('complementaryCategories', 'name slug')
    .lean();
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  response.status(200).json({ message: 'Product fetched successfully', data: toPublicProduct(product as Record<string, any>) });
};

export const getAllProducts: RequestHandler = async (request, response) => {
  const { page, limit } = paginationSchema.parse(request.query);
  const filter: Record<string, unknown> = {};
  if (typeof request.query.status === 'string' && ['draft', 'active', 'archived'].includes(request.query.status)) filter.status = request.query.status;
  if (typeof request.query.categoryId === 'string') filter.category = objectIdSchema.parse(request.query.categoryId);
  if (typeof request.query.q === 'string' && request.query.q.trim()) {
    const expression = new RegExp(escapeRegex(request.query.q.trim()), 'i');
    filter.$or = [{ name: expression }, { slug: expression }];
  }
  const [products, total] = await Promise.all([
    ProductModel.find(filter)
      .populate('category', 'name slug status')
      .populate('complementaryCategories', 'name slug')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ProductModel.countDocuments(filter),
  ]);
  response.status(200).json({
    message: 'Products fetched successfully',
    data: products.map((product) => toAdminProduct(product as Record<string, any>)),
    meta: { page, limit, total },
  });
};

export const getProductById: RequestHandler = async (request, response) => {
  const product = await loadPopulatedProduct(objectIdSchema.parse(request.params.id));
  response.status(200).json({ message: 'Product fetched successfully', data: toAdminProduct(product) });
};

export const createProduct: RequestHandler = async (request, response) => {
  const input = productCreateSchema.parse(request.body);
  assertManagedImages(input.images);
  await assertCategories(input.categoryId, input.complementaryCategoryIds, input.status === 'active');
  const product = await ProductModel.create({ slug: input.slug, ...toProductPersistence(input), updatedBy: request.admin!.email });
  response.status(201).json({
    message: 'Product created successfully',
    data: toAdminProduct(await loadPopulatedProduct(String(product._id))),
  });
};

export const updateProduct: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  const updates = productUpdateSchema.parse(request.body);
  const current = await ProductModel.findById(id).lean();
  if (!current) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  const merged = productCreateSchema.parse({
    slug: current.slug,
    name: current.name,
    categoryId: String(current.category),
    shortDescription: current.shortDescription,
    description: current.description,
    price: fromPesewas(current.pricePesewas),
    compareAtPrice: fromPesewas(current.compareAtPricePesewas),
    images: current.images,
    stockQuantity: current.stockQuantity,
    lowStockThreshold: current.lowStockThreshold,
    featured: current.featured,
    isNew: current.newArrival,
    isBestSeller: current.isBestSeller,
    complementaryCategoryIds: current.complementaryCategories.map(String),
    details: current.details,
    specifications: current.specifications,
    status: current.status === 'archived' ? 'draft' : current.status,
    ...updates,
  });
  assertManagedImages(merged.images);
  await assertCategories(merged.categoryId, merged.complementaryCategoryIds, merged.status === 'active');
  await ProductModel.findByIdAndUpdate(id, { ...toProductPersistence(merged), updatedBy: request.admin!.email }, { runValidators: true });
  response.status(200).json({ message: 'Product updated successfully', data: toAdminProduct(await loadPopulatedProduct(id)) });
};

export const archiveProduct: RequestHandler = async (request, response) => {
  const product = await ProductModel.findByIdAndUpdate(
    objectIdSchema.parse(request.params.id),
    { status: 'archived', updatedBy: request.admin!.email },
    { returnDocument: 'after' },
  );
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  response.status(200).json({ message: 'Product archived successfully', data: toAdminProduct(await loadPopulatedProduct(String(product._id))) });
};

export const restoreProduct: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  const product = await ProductModel.findByIdAndUpdate(
    id,
    { status: 'draft', updatedBy: request.admin!.email },
    { returnDocument: 'after' },
  );
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  response.status(200).json({ message: 'Product restored successfully', data: toAdminProduct(await loadPopulatedProduct(id)) });
};

import type { RequestHandler } from 'express';
import { z } from 'zod';
import { getEnvironment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';
import { CategoryModel } from '../models/CategorySchema.js';
import { ProductModel } from '../models/ProductSchema.js';
import { categoryCreateSchema, categoryUpdateSchema, objectIdSchema } from '../validation/schemas.js';

const categoryOrderSchema = z.object({
  items: z.array(z.object({ id: objectIdSchema, displayOrder: z.number().int().nonnegative() })).min(1).max(100),
});

function categoryDto(category: Record<string, any>) {
  return {
    id: String(category._id),
    name: category.name,
    slug: category.slug,
    description: category.description,
    image: category.image,
    displayOrder: category.displayOrder,
    status: category.status,
    updatedBy: category.updatedBy,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

function assertManagedImage(image?: { publicId?: string | undefined }): void {
  if (!image) return;
  const prefix = `${getEnvironment().CLOUDINARY_FOLDER}/`;
  if (!image.publicId?.startsWith(prefix)) {
    throw new AppError(400, 'INVALID_MEDIA_ASSET', 'The category image must be uploaded to the Kawama Cloudinary folder.');
  }
}

export const getPublicCategories: RequestHandler = async (_request, response) => {
  const categories = await CategoryModel.find({ status: 'active' }).sort({ displayOrder: 1, name: 1 }).lean();
  response.status(200).json({
    message: 'Categories fetched successfully',
    data: categories.map((category: any) => ({
      id: String(category._id),
      name: category.name,
      slug: category.slug,
      description: category.description,
      image: category.image ? { src: category.image.src, alt: category.image.alt } : undefined,
      displayOrder: category.displayOrder,
    })),
  });
};

export const getAllCategories: RequestHandler = async (request, response) => {
  const status = request.query.status === 'archived' ? 'archived' : request.query.status === 'active' ? 'active' : undefined;
  const categories = await CategoryModel.find(status ? { status } : {}).sort({ displayOrder: 1, name: 1 }).lean();
  response.status(200).json({ message: 'Categories fetched successfully', data: categories.map((item) => categoryDto(item as Record<string, any>)) });
};

export const getCategoryById: RequestHandler = async (request, response) => {
  const category = await CategoryModel.findById(objectIdSchema.parse(request.params.id)).lean();
  if (!category) throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
  response.status(200).json({ message: 'Category fetched successfully', data: categoryDto(category as Record<string, any>) });
};

export const createCategory: RequestHandler = async (request, response) => {
  const input = categoryCreateSchema.parse(request.body);
  assertManagedImage(input.image);
  const category = await CategoryModel.create({ ...input, updatedBy: request.admin!.email });
  response.status(201).json({ message: 'Category created successfully', data: categoryDto(category.toObject()) });
};

export const updateCategoryOrder: RequestHandler = async (request, response) => {
  const input = categoryOrderSchema.parse(request.body);
  await Promise.all(input.items.map(({ id, displayOrder }) =>
    CategoryModel.findByIdAndUpdate(id, { displayOrder, updatedBy: request.admin!.email }),
  ));
  response.status(200).json({ message: 'Category order updated successfully', data: { updated: input.items.length } });
};

export const updateCategory: RequestHandler = async (request, response) => {
  const input = categoryUpdateSchema.parse(request.body);
  assertManagedImage(input.image);
  const category = await CategoryModel.findByIdAndUpdate(
    objectIdSchema.parse(request.params.id),
    { ...input, updatedBy: request.admin!.email },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!category) throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
  response.status(200).json({ message: 'Category updated successfully', data: categoryDto(category as Record<string, any>) });
};

export const archiveCategory: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  const inUse = await ProductModel.exists({ category: id, status: { $ne: 'archived' } });
  if (inUse) throw new AppError(409, 'CATEGORY_IN_USE', 'Reassign or archive products in this category first.');
  const category = await CategoryModel.findByIdAndUpdate(
    id,
    { status: 'archived', updatedBy: request.admin!.email },
    { returnDocument: 'after' },
  ).lean();
  if (!category) throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
  response.status(200).json({ message: 'Category archived successfully', data: categoryDto(category as Record<string, any>) });
};

export const restoreCategory: RequestHandler = async (request, response) => {
  const category = await CategoryModel.findByIdAndUpdate(
    objectIdSchema.parse(request.params.id),
    { status: 'active', updatedBy: request.admin!.email },
    { returnDocument: 'after' },
  ).lean();
  if (!category) throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
  response.status(200).json({ message: 'Category restored successfully', data: categoryDto(category as Record<string, any>) });
};

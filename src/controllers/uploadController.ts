import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/AppError.js';
import { CategoryModel } from '../models/CategorySchema.js';
import { ProductModel } from '../models/ProductSchema.js';
import type { MediaService } from '../services/cloudinary.service.js';

export const createUploadSignature = (mediaService: MediaService): RequestHandler => (_request, response) => {
  response.status(200).json({ message: 'Upload signature created successfully', data: mediaService.createUploadSignature() });
};

export const deleteUpload = (mediaService: MediaService): RequestHandler => async (request, response) => {
  const { publicId } = z.object({ publicId: z.string().trim().min(1) }).parse(request.body);
  const inUse = (await ProductModel.exists({ 'images.publicId': publicId }))
    ?? (await CategoryModel.exists({ 'image.publicId': publicId }));
  if (inUse) throw new AppError(409, 'ASSET_IN_USE', 'Remove this asset from its product or category first.');
  await mediaService.destroy(publicId);
  response.status(200).json({ message: 'Upload deleted successfully', data: { deleted: true } });
};

import type { RequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../errors/AppError.js';
import { ProductModel } from '../models/ProductSchema.js';
import { ReviewModel } from '../models/ReviewSchema.js';
import { objectIdSchema, paginationSchema, reviewCreateSchema, reviewStatusSchema } from '../validation/schemas.js';

function reviewDto(review: Record<string, any>) {
  return {
    id: String(review._id),
    productId: String(review.product),
    reviewerName: review.reviewerName,
    rating: review.rating,
    comment: review.comment,
    createdAt: new Date(review.createdAt).toISOString(),
  };
}

export const getApprovedReviews: RequestHandler = async (request, response) => {
  const productId = String(request.params.productId);
  if (!mongoose.Types.ObjectId.isValid(productId)) throw new AppError(400, 'INVALID_ID', 'The product ID is invalid.');
  const product = await ProductModel.exists({ _id: productId, status: 'active' });
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  const reviews = await ReviewModel.find({ product: productId, status: 'approved' }).sort({ createdAt: -1 }).lean();
  response.status(200).json({ message: 'Reviews fetched successfully', data: reviews.map((review) => reviewDto(review as Record<string, any>)) });
};

export const submitReview: RequestHandler = async (request, response) => {
  const productId = String(request.params.productId);
  if (!mongoose.Types.ObjectId.isValid(productId)) throw new AppError(400, 'INVALID_ID', 'The product ID is invalid.');
  const input = reviewCreateSchema.parse(request.body);
  const product = await ProductModel.exists({ _id: productId, status: 'active' });
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  const review = await ReviewModel.create({ ...input, product: productId, status: 'pending' });
  response.status(202).json({ message: 'Review submitted for approval', data: { id: String(review._id), status: 'pending' } });
};

export const getAllReviews: RequestHandler = async (request, response) => {
  const { page, limit } = paginationSchema.parse(request.query);
  const filter: Record<string, unknown> = {};
  if (typeof request.query.status === 'string' && ['pending', 'approved', 'rejected', 'archived'].includes(request.query.status)) filter.status = request.query.status;
  if (typeof request.query.productId === 'string') filter.product = objectIdSchema.parse(request.query.productId);
  const [reviews, total] = await Promise.all([
    ReviewModel.find(filter).populate('product', 'name slug').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ReviewModel.countDocuments(filter),
  ]);
  response.status(200).json({
    message: 'Reviews fetched successfully',
    data: reviews.map((review: any) => ({ ...review, id: String(review._id), _id: undefined })),
    meta: { page, limit, total },
  });
};

export const updateReviewStatus: RequestHandler = async (request, response) => {
  const { status } = reviewStatusSchema.parse(request.body);
  const review = await ReviewModel.findByIdAndUpdate(
    objectIdSchema.parse(request.params.id),
    { status, moderatedBy: request.admin!.email, moderatedAt: new Date() },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!review) throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review not found');
  response.status(200).json({ message: 'Review updated successfully', data: { ...review, id: String(review._id), _id: undefined } });
};

export const archiveReview: RequestHandler = async (request, response) => {
  const review = await ReviewModel.findByIdAndUpdate(
    objectIdSchema.parse(request.params.id),
    { status: 'archived', moderatedBy: request.admin!.email, moderatedAt: new Date() },
    { returnDocument: 'after' },
  ).lean();
  if (!review) throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review not found');
  response.status(200).json({ message: 'Review archived successfully', data: { id: String(review._id), status: review.status } });
};

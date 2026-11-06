import type { RequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../errors/AppError.js';
import { ProductModel } from '../models/ProductSchema.js';
import { OrderModel } from '../models/OrderSchema.js';
import { ReviewInvitationModel } from '../models/ReviewInvitationSchema.js';
import { ReviewModel } from '../models/ReviewSchema.js';
import { verifyReviewInvitationToken } from '../services/review-links.service.js';
import { objectIdSchema, paginationSchema, reviewCreateSchema, reviewReplySchema } from '../validation/schemas.js';

function replyDto(reply: Record<string, any> | null | undefined) {
  if (!reply?.text) return null;
  return {
    text: reply.text,
    createdAt: new Date(reply.createdAt).toISOString(),
    updatedAt: new Date(reply.updatedAt).toISOString(),
  };
}

function reviewDto(review: Record<string, any>) {
  return {
    id: String(review._id),
    productId: String(review.product),
    reviewerName: review.reviewerName,
    rating: review.rating,
    comment: review.comment,
    reply: replyDto(review.reply),
    createdAt: new Date(review.createdAt).toISOString(),
  };
}

function adminReviewDto(review: Record<string, any>) {
  const product = review.product && typeof review.product === 'object' && 'name' in review.product
    ? { id: String(review.product._id), name: review.product.name, slug: review.product.slug }
    : { id: String(review.product) };
  return {
    ...reviewDto({ ...review, product: product.id }),
    product,
    orderId: review.order ? String(review.order) : null,
    status: review.status,
    updatedAt: new Date(review.updatedAt).toISOString(),
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
  const { token, ...input } = reviewCreateSchema.parse(request.body);
  const invitationId = verifyReviewInvitationToken(token);
  const existingInvitation = await ReviewInvitationModel.findById(invitationId).lean();
  if (!existingInvitation) throw new AppError(404, 'INVALID_REVIEW_LINK', 'This review link is invalid.');
  if (String(existingInvitation.product) !== productId) {
    throw new AppError(409, 'REVIEW_PRODUCT_MISMATCH', 'This review link is for a different product.');
  }
  if (existingInvitation.usedAt) {
    throw new AppError(409, 'REVIEW_ALREADY_SUBMITTED', 'A review has already been submitted with this link.');
  }

  let review: Record<string, any> | undefined;
  try {
    await mongoose.connection.transaction(async (session) => {
      const invitation = await ReviewInvitationModel.findOneAndUpdate(
        { _id: invitationId, usedAt: null },
        { $set: { usedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!invitation) {
        throw new AppError(409, 'REVIEW_ALREADY_SUBMITTED', 'A review has already been submitted with this link.');
      }
      if (String(invitation.product) !== productId) {
        throw new AppError(409, 'REVIEW_PRODUCT_MISMATCH', 'This review link is for a different product.');
      }

      const order = await OrderModel.findOne({
        _id: invitation.order,
        paymentStatus: 'paid',
        'items.product': invitation.product,
      }).session(session).lean();
      const product = await ProductModel.findById(invitation.product).session(session).lean();
      if (!order) {
        throw new AppError(409, 'REVIEW_ORDER_INELIGIBLE', 'This order is not eligible for a review.');
      }
      if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');

      const created = await ReviewModel.create([{
        ...input,
        product: invitation.product,
        order: invitation.order,
        invitation: invitation._id,
        status: 'approved',
      }], { session });
      review = created[0]!.toObject();
      invitation.review = created[0]!._id;
      await invitation.save({ session });
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      throw new AppError(409, 'REVIEW_ALREADY_SUBMITTED', 'A review has already been submitted for this purchase.');
    }
    throw error;
  }

  response.status(201).json({
    message: 'Review submitted successfully',
    data: { id: String(review!._id), status: 'approved' },
  });
};

export const getReviewLink: RequestHandler = async (request, response) => {
  const invitationId = verifyReviewInvitationToken(String(request.params.token));
  const invitation = await ReviewInvitationModel.findById(invitationId).lean();
  if (!invitation) throw new AppError(404, 'INVALID_REVIEW_LINK', 'This review link is invalid.');
  response.status(200).json({
    message: 'Review link fetched successfully',
    data: {
      product: {
        id: String(invitation.product),
        name: invitation.productName,
        slug: invitation.productSlug,
      },
      alreadySubmitted: Boolean(invitation.usedAt),
    },
  });
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
    data: reviews.map((review: any) => adminReviewDto(review)),
    meta: { page, limit, total },
  });
};

export const replyToReview: RequestHandler = async (request, response) => {
  const { text } = reviewReplySchema.parse(request.body);
  const review = await ReviewModel.findById(objectIdSchema.parse(request.params.id));
  if (!review) throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review not found');
  const now = new Date();
  review.reply = {
    text,
    createdAt: review.reply?.createdAt ?? now,
    updatedAt: now,
  };
  await review.save();
  response.status(200).json({
    message: 'Review reply saved successfully',
    data: { id: String(review._id), reply: replyDto(review.reply?.toObject?.() ?? review.reply) },
  });
};

export const archiveReview: RequestHandler = async (request, response) => {
  const review = await ReviewModel.findByIdAndUpdate(
    objectIdSchema.parse(request.params.id),
    { status: 'archived', moderatedBy: request.admin!.email, moderatedAt: new Date() },
    { returnDocument: 'after' },
  ).lean();
  if (!review) throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review not found');
  response.status(200).json({ message: 'Review archived successfully', data: adminReviewDto(review) });
};

import { createHmac, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import { getEnvironment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';
import { OrderModel } from '../models/OrderSchema.js';
import { ReviewInvitationModel } from '../models/ReviewInvitationSchema.js';

const TOKEN_VERSION = 'v1';
const TOKEN_PURPOSE = 'kawama:review-link:v1';

function configuration() {
  const { REVIEW_LINK_SECRET, STOREFRONT_BASE_URL } = getEnvironment();
  if (!REVIEW_LINK_SECRET || !STOREFRONT_BASE_URL) {
    throw new AppError(
      503,
      'REVIEW_LINKS_NOT_CONFIGURED',
      'Purchase review links are not configured.',
    );
  }
  return { secret: REVIEW_LINK_SECRET, storefrontBaseUrl: STOREFRONT_BASE_URL };
}

function signature(invitationId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${TOKEN_PURPOSE}:${invitationId}`)
    .digest('base64url');
}

export function createReviewInvitationToken(invitationId: string): string {
  const { secret } = configuration();
  return `${TOKEN_VERSION}.${invitationId}.${signature(invitationId, secret)}`;
}

export function verifyReviewInvitationToken(token: string): string {
  const { secret } = configuration();
  const match = /^v1\.([a-f\d]{24})\.([A-Za-z0-9_-]{43})$/i.exec(token);
  if (!match) throw new AppError(404, 'INVALID_REVIEW_LINK', 'This review link is invalid.');

  const invitationId = match[1]!;
  const supplied = Buffer.from(match[2]!, 'base64url');
  const expected = Buffer.from(signature(invitationId, secret), 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AppError(404, 'INVALID_REVIEW_LINK', 'This review link is invalid.');
  }
  return invitationId;
}

function reviewUrl(productSlug: string, token: string): string {
  const { storefrontBaseUrl } = configuration();
  const url = new URL(`/review/${encodeURIComponent(productSlug)}`, storefrontBaseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

async function getOrCreateInvitation(order: Record<string, any>, item: Record<string, any>) {
  const invitationId = new mongoose.Types.ObjectId();
  try {
    return await ReviewInvitationModel.findOneAndUpdate(
      { order: order._id, product: item.product },
      {
        $setOnInsert: {
          _id: invitationId,
          order: order._id,
          product: item.product,
          productName: item.name,
          productSlug: item.slug,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return ReviewInvitationModel.findOne({ order: order._id, product: item.product }).lean();
    }
    throw error;
  }
}

export async function issueReviewLinks(orderId: string) {
  configuration();
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw new AppError(400, 'INVALID_ID', 'The order ID is invalid.');
  }

  const order = await OrderModel.findById(orderId).lean();
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (order.paymentStatus !== 'paid') {
    throw new AppError(409, 'ORDER_NOT_PAID', 'Review links are available only for verified paid orders.');
  }

  const distinctItems = [...new Map(
    order.items.map((item: Record<string, any>) => [String(item.product), item]),
  ).values()] as Record<string, any>[];
  const products = [];
  for (const item of distinctItems) {
    const invitation = await getOrCreateInvitation(order as Record<string, any>, item);
    if (!invitation) throw new AppError(500, 'REVIEW_INVITATION_ERROR', 'The review invitation could not be created.');
    const alreadySubmitted = Boolean(invitation.usedAt);
    products.push({
      productId: String(item.product),
      name: item.name,
      reviewState: alreadySubmitted ? 'submitted' : 'available',
      reviewUrl: alreadySubmitted
        ? null
        : reviewUrl(invitation.productSlug, createReviewInvitationToken(String(invitation._id))),
    });
  }

  return { orderNumber: order.orderNumber, products };
}

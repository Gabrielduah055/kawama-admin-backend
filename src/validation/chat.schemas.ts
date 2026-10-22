import { z } from 'zod';
import { toPesewas } from '../lib/catalog.js';
import { objectIdSchema, slugSchema } from './schemas.js';

const priceSchema = z.number().finite().nonnegative().max(10_000_000).refine(
  (value) => {
    try {
      toPesewas(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Must contain at most two decimal places.' },
);

export const searchProductsToolSchema = z.object({
  query: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  minPrice: priceSchema.optional(),
  maxPrice: priceSchema.optional(),
  availability: z.enum(['any', 'in_stock', 'out_of_stock']).default('any'),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'newest', 'name']).default('relevance'),
  limit: z.number().int().min(1).max(6).default(4),
}).strict().superRefine((value, context) => {
  if (value.minPrice !== undefined && value.maxPrice !== undefined && value.minPrice > value.maxPrice) {
    context.addIssue({ code: 'custom', path: ['maxPrice'], message: 'Must be greater than or equal to minPrice.' });
  }
});

export const getProductDetailsToolSchema = z.object({
  identifiers: z.array(z.union([objectIdSchema, slugSchema])).min(1).max(4),
}).strict();

export const getStorePoliciesToolSchema = z.object({}).strict();

const productContextSchema = z.object({
  productId: objectIdSchema.optional(),
  productSlug: slugSchema.optional(),
}).strict().refine((value) => Boolean(value.productId || value.productSlug), {
  message: 'Provide productId or productSlug.',
});

export const chatRequestSchema = z.object({
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1).max(1_500),
  context: productContextSchema.optional(),
}).strict();

export const chatSessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid chat session token.');

export const assistantResponseSchema = z.object({
  assistantMessage: z.string().trim().min(1).max(2_000),
  productIds: z.array(objectIdSchema).max(4).default([]),
  suggestedFollowUps: z.array(z.string().trim().min(1).max(120)).max(3).default([]),
}).strict();

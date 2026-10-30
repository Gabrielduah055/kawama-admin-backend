import { z } from 'zod';
import { objectIdSchema } from './schemas.js';

const optionalQueryText = (maximum: number) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).max(maximum).optional(),
);

const priceSchema = z.coerce.number().nonnegative().refine((value) => Number.isInteger(value * 100), {
  message: 'Must contain at most two decimal places.',
});

const preferencesSchema = z.preprocess(
  (value) => value === undefined ? [] : Array.isArray(value) ? value : [value],
  z.array(z.string().trim().min(1).max(100)).max(10),
);

export const orderBridgeProductSearchSchema = z.object({
  query: optionalQueryText(300),
  limit: z.coerce.number().int().min(1).max(10).default(10),
  minPrice: priceSchema.optional(),
  maxPrice: priceSchema.optional(),
  category: optionalQueryText(100),
  available: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  preference: preferencesSchema,
  sort: z.enum(['relevance', 'price_asc', 'price_desc']).default('relevance'),
}).strict().superRefine((value, context) => {
  if (!value.query && !value.category && value.preference.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['query'],
      message: 'At least one of query, category, or preference is required.',
    });
  }
  if (value.minPrice !== undefined && value.maxPrice !== undefined && value.minPrice > value.maxPrice) {
    context.addIssue({ code: 'custom', path: ['maxPrice'], message: 'Must be greater than or equal to minPrice.' });
  }
});

export const orderBridgeProductIdSchema = objectIdSchema.transform((value) => value.toLowerCase());

export const orderBridgePoliciesQuerySchema = z.object({
  topic: optionalQueryText(200),
}).strict();

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

const productAvailabilitySchema = z.enum(['in_stock', 'low_stock', 'out_of_stock']);
const contentReferenceIndexesSchema = z.array(z.number().int().min(0).max(999)).min(1).max(6)
  .refine((indexes) => new Set(indexes).size === indexes.length, { message: 'Content indexes must be unique.' });

const productClaimSchema = z.object({
  productId: objectIdSchema,
  pricePesewas: z.number().int().nonnegative().max(1_000_000_000).optional(),
  availability: productAvailabilitySchema.optional(),
  warranty: z.string().trim().min(1).max(500).nullable().optional(),
  material: z.string().trim().min(1).max(500).nullable().optional(),
  customerBudgetPesewas: z.number().int().nonnegative().max(1_000_000_000).optional(),
  includeSummary: z.boolean().optional(),
  includeSpecifications: z.boolean().optional(),
  specificationIndexes: contentReferenceIndexesSchema.optional(),
  detailIndexes: contentReferenceIndexesSchema.optional(),
  descriptionSectionIndexes: contentReferenceIndexesSchema.optional(),
}).strict().refine((claim) => Object.entries(claim).some(([key, value]) =>
  key !== 'productId' && value !== undefined && value !== false), {
  message: 'Select at least one fact to include.',
});

const textPolicyClaimSchema = z.object({
  topic: z.enum(['delivery', 'payment', 'return']),
  value: z.string().trim().min(1).max(2_000).nullable(),
}).strict();

const contactPolicyClaimSchema = z.object({
  topic: z.literal('contact'),
  email: z.string().trim().email().nullable(),
  phone: z.string().trim().max(40).nullable(),
  whatsappUrl: z.string().trim().url().nullable(),
}).strict();

const checkoutPolicyClaimSchema = z.object({
  topic: z.literal('checkout'),
  productPaymentProvider: z.literal('Paystack'),
  productPaymentScope: z.literal('products_only'),
  deliveryPaymentMethod: z.literal('pay_on_delivery'),
}).strict();

const policyClaimSchema = z.discriminatedUnion('topic', [
  textPolicyClaimSchema,
  contactPolicyClaimSchema,
  checkoutPolicyClaimSchema,
]);

const productClaimsSchema = z.array(productClaimSchema).min(1).max(4).superRefine((claims, context) => {
  const seen = new Set<string>();
  claims.forEach((claim, index) => {
    if (seen.has(claim.productId)) {
      context.addIssue({ code: 'custom', path: [index, 'productId'], message: 'Product claims must be unique.' });
    }
    seen.add(claim.productId);
  });
});

const policyClaimsSchema = z.array(policyClaimSchema).min(1).max(5).superRefine((claims, context) => {
  const seen = new Set<string>();
  claims.forEach((claim, index) => {
    if (seen.has(claim.topic)) {
      context.addIssue({ code: 'custom', path: [index, 'topic'], message: 'Policy topics must be unique.' });
    }
    seen.add(claim.topic);
  });
});

export const assistantResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('greeting') }).strict(),
  z.object({
    type: z.literal('clarification'),
    purpose: z.enum(['budget', 'intended_use', 'product', 'category', 'preferences', 'delivery_location']),
  }).strict(),
  z.object({ type: z.literal('product_answer'), productClaims: productClaimsSchema }).strict(),
  z.object({ type: z.literal('policy_answer'), policyClaims: policyClaimsSchema }).strict(),
  z.object({
    type: z.literal('mixed_answer'),
    productClaims: productClaimsSchema,
    policyClaims: policyClaimsSchema,
  }).strict(),
  z.object({ type: z.literal('no_match') }).strict(),
  z.object({ type: z.literal('unavailable_reference') }).strict(),
]);

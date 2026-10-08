import { z } from 'zod';

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a MongoDB ObjectId.');
export const slugSchema = z.string().trim().min(2).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const moneySchema = z.number().nonnegative().refine((value) => Number.isInteger(value * 100), {
  message: 'Must contain at most two decimal places.',
});
const imageSchema = z.object({
  publicId: z.string().trim().min(1).optional(),
  src: z.string().url(),
  alt: z.string().trim().min(2).max(200),
  position: z.number().int().nonnegative().default(0),
});

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: slugSchema,
  description: z.string().trim().max(500).default(''),
  image: imageSchema.omit({ position: true }).optional(),
  displayOrder: z.number().int().nonnegative().default(0),
  status: z.enum(['active', 'archived']).default('active'),
});
export const categoryUpdateSchema = categoryCreateSchema.omit({ slug: true }).partial().strict();

const productBaseSchema = z.object({
    slug: slugSchema,
    name: z.string().trim().min(2).max(120),
    categoryId: objectIdSchema,
    shortDescription: z.string().trim().max(240).default(''),
    description: z.string().trim().max(5000).default(''),
    price: moneySchema.default(0),
    compareAtPrice: moneySchema.optional(),
    images: z.array(imageSchema).max(8).default([]),
    stockQuantity: z.number().int().nonnegative().default(0),
    lowStockThreshold: z.number().int().nonnegative().default(5),
    featured: z.boolean().default(false),
    isNew: z.boolean().default(false),
    isBestSeller: z.boolean().default(false),
    complementaryCategoryIds: z.array(objectIdSchema).max(12).default([]),
    details: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    specifications: z
      .array(z.object({ label: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(200) }))
      .max(30)
      .default([]),
    status: z.enum(['draft', 'active']).default('draft'),
  });

export const productCreateSchema = productBaseSchema
  .superRefine((value, context) => {
    if (value.compareAtPrice !== undefined && value.compareAtPrice <= value.price) {
      context.addIssue({ code: 'custom', path: ['compareAtPrice'], message: 'Must be greater than the price.' });
    }
    if (value.status === 'active') {
      if (!value.shortDescription) context.addIssue({ code: 'custom', path: ['shortDescription'], message: 'Required for active products.' });
      if (!value.description) context.addIssue({ code: 'custom', path: ['description'], message: 'Required for active products.' });
      if (value.price <= 0) context.addIssue({ code: 'custom', path: ['price'], message: 'Must be positive for active products.' });
      if (value.images.length === 0) context.addIssue({ code: 'custom', path: ['images'], message: 'At least one image is required.' });
    }
  });

export const productUpdateSchema = productBaseSchema.omit({ slug: true }).partial().strict();
export const reviewCreateSchema = z.object({
  reviewerName: z.string().trim().min(2).max(60),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(10).max(500),
});
export const reviewStatusSchema = z.object({ status: z.enum(['approved', 'rejected', 'archived']) });

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(24),
});

import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

const productImageSchema = new Schema(
  {
    publicId: { type: String, trim: true },
    src: { type: String, trim: true, required: true },
    alt: { type: String, trim: true, required: true, maxlength: 200 },
    position: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
);

const productSpecificationSchema = new Schema(
  {
    label: { type: String, trim: true, required: true, maxlength: 80 },
    value: { type: String, trim: true, required: true, maxlength: 200 },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    slug: { type: String, trim: true, lowercase: true, required: true, immutable: true },
    name: { type: String, trim: true, required: true, maxlength: 120 },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    shortDescription: { type: String, trim: true, default: '', maxlength: 240 },
    description: { type: String, trim: true, default: '', maxlength: 5000 },
    pricePesewas: { type: Number, min: 0, default: 0 },
    compareAtPricePesewas: { type: Number, min: 0 },
    currency: { type: String, enum: ['GHS'], default: 'GHS' },
    images: { type: [productImageSchema], default: [] },
    stockQuantity: { type: Number, min: 0, default: 0 },
    lowStockThreshold: { type: Number, min: 0, default: 5 },
    featured: { type: Boolean, default: false, index: true },
    newArrival: { type: Boolean, default: false },
    isBestSeller: { type: Boolean, default: false },
    complementaryCategories: [{ type: Schema.Types.ObjectId, ref: 'Category' }],
    details: { type: [String], default: [] },
    specifications: { type: [productSpecificationSchema], default: [] },
    status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft', index: true },
    updatedBy: { type: String, trim: true },
  },
  { timestamps: true, versionKey: false },
);

productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ status: 1, category: 1, featured: -1, createdAt: -1 });
productSchema.index({ name: 'text', shortDescription: 'text', description: 'text' });

export const ProductModel = ((models.Product as Model<any> | undefined) ?? model<any>('Product', productSchema)) as Model<any>;
export default ProductModel;

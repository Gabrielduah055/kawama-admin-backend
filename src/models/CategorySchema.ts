import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

const categoryImageSchema = new Schema(
  {
    publicId: { type: String, trim: true },
    src: { type: String, trim: true, required: true },
    alt: { type: String, trim: true, required: true },
  },
  { _id: false },
);

const categorySchema = new Schema(
  {
    name: { type: String, trim: true, required: true, maxlength: 80 },
    slug: { type: String, trim: true, lowercase: true, required: true, immutable: true },
    description: { type: String, trim: true, default: '', maxlength: 500 },
    image: { type: categoryImageSchema },
    displayOrder: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
    updatedBy: { type: String, trim: true },
  },
  { timestamps: true, versionKey: false },
);

categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ status: 1, displayOrder: 1, name: 1 });

export const CategoryModel = ((models.Category as Model<any> | undefined) ?? model<any>('Category', categorySchema)) as Model<any>;
export default CategoryModel;

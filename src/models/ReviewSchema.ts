import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

const reviewSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    reviewerName: { type: String, trim: true, required: true, minlength: 2, maxlength: 60 },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, trim: true, required: true, minlength: 10, maxlength: 500 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'archived'], default: 'pending', index: true },
    moderatedBy: { type: String, trim: true },
    moderatedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

reviewSchema.index({ product: 1, status: 1, createdAt: -1 });
reviewSchema.index({ status: 1, createdAt: -1 });

export const ReviewModel = ((models.Review as Model<any> | undefined) ?? model<any>('Review', reviewSchema)) as Model<any>;
export default ReviewModel;

import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

const reviewSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order', index: true },
    invitation: { type: Schema.Types.ObjectId, ref: 'ReviewInvitation' },
    reviewerName: { type: String, trim: true, required: true, minlength: 2, maxlength: 60 },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, trim: true, required: true, minlength: 10, maxlength: 500 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'archived'], default: 'pending', index: true },
    moderatedBy: { type: String, trim: true },
    moderatedAt: { type: Date },
    reply: {
      text: { type: String, trim: true, minlength: 1, maxlength: 1000 },
      createdAt: { type: Date },
      updatedAt: { type: Date },
    },
  },
  { timestamps: true, versionKey: false },
);

reviewSchema.index({ product: 1, status: 1, createdAt: -1 });
reviewSchema.index({ status: 1, createdAt: -1 });
reviewSchema.index(
  { order: 1, product: 1 },
  { unique: true, partialFilterExpression: { order: { $type: 'objectId' } } },
);

export const ReviewModel = ((models.Review as Model<any> | undefined) ?? model<any>('Review', reviewSchema)) as Model<any>;
export default ReviewModel;

import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

const reviewInvitationSchema = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    productName: { type: String, trim: true, required: true, maxlength: 120 },
    productSlug: { type: String, trim: true, required: true, maxlength: 100 },
    usedAt: { type: Date, default: null },
    review: { type: Schema.Types.ObjectId, ref: 'Review' },
  },
  { timestamps: true, versionKey: false },
);

reviewInvitationSchema.index({ order: 1, product: 1 }, { unique: true });

export const ReviewInvitationModel = (
  (models.ReviewInvitation as Model<any> | undefined)
  ?? model<any>('ReviewInvitation', reviewInvitationSchema)
) as Model<any>;

export default ReviewInvitationModel;

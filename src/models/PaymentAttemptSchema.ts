import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

export const paymentAttemptStatuses = [
  'initializing',
  'initialized',
  'success',
  'failed',
  'needs_attention',
] as const;

const paymentAttemptSchema = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    provider: { type: String, enum: ['paystack'], default: 'paystack', immutable: true },
    reference: { type: String, trim: true, required: true, immutable: true },
    amountPesewas: { type: Number, min: 0, required: true, immutable: true },
    currency: { type: String, enum: ['GHS'], default: 'GHS', immutable: true },
    status: { type: String, enum: paymentAttemptStatuses, default: 'initializing', index: true },
    accessCode: { type: String, trim: true, select: false },
    authorizationUrl: { type: String, trim: true, select: false },
    providerTransactionId: { type: String, trim: true },
    providerStatus: { type: String, trim: true },
    lastErrorCode: { type: String, trim: true },
    initializedAt: { type: Date },
    verifiedAt: { type: Date },
    paidAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

paymentAttemptSchema.index({ reference: 1 }, { unique: true });
paymentAttemptSchema.index({ order: 1, createdAt: -1 });

export const PaymentAttemptModel = ((models.PaymentAttempt as Model<any> | undefined) ??
  model<any>('PaymentAttempt', paymentAttemptSchema)) as Model<any>;
export default PaymentAttemptModel;

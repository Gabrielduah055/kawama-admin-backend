import { randomUUID } from 'node:crypto';
import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

const orderBridgeChatSessionSchema = new Schema(
  {
    _id: { type: String, default: randomUUID },
    ownerHash: { type: String, required: true, minlength: 64, maxlength: 64, index: true },
    businessId: {
      type: String,
      required: true,
      match: /^[a-fA-F0-9]{24}$/,
      minlength: 24,
      maxlength: 24,
    },
    upstreamConversationId: {
      type: String,
      required: true,
      match: /^[A-Za-z0-9_-]{43}$/,
      minlength: 43,
      maxlength: 43,
      select: false,
    },
    upstreamConversationToken: {
      type: String,
      required: true,
      match: /^v1\.[A-Za-z0-9_-]{43}$/,
      minlength: 46,
      maxlength: 46,
      select: false,
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

orderBridgeChatSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
orderBridgeChatSessionSchema.index({ ownerHash: 1, businessId: 1, updatedAt: -1 });
orderBridgeChatSessionSchema.index(
  { businessId: 1, upstreamConversationId: 1 },
  { unique: true },
);

export const OrderBridgeChatSessionModel = (
  (models.OrderBridgeChatSession as Model<any> | undefined)
  ?? model<any>('OrderBridgeChatSession', orderBridgeChatSessionSchema)
) as Model<any>;

export default OrderBridgeChatSessionModel;

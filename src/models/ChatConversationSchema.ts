import { randomUUID } from 'node:crypto';
import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

const chatMessageSchema = new Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, maxlength: 2_000 },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const chatConversationSchema = new Schema(
  {
    _id: { type: String, default: randomUUID },
    ownerHash: { type: String, required: true, minlength: 64, maxlength: 64, index: true },
    messages: { type: [chatMessageSchema], default: [] },
    lastShownProductIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

chatConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
chatConversationSchema.index({ ownerHash: 1, updatedAt: -1 });

export const ChatConversationModel = ((models.ChatConversation as Model<any> | undefined) ??
  model<any>('ChatConversation', chatConversationSchema)) as Model<any>;
export default ChatConversationModel;

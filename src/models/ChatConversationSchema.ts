import { randomUUID } from 'node:crypto';
import mongoose, { type Model } from 'mongoose';
import { CHAT_MESSAGE_MAX_LENGTH } from '../lib/chat.js';

const { Schema, model, models } = mongoose;

const chatMessageSchema = new Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, maxlength: CHAT_MESSAGE_MAX_LENGTH },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const shownProductReferenceSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, trim: true, required: true, maxlength: 120 },
    slug: { type: String, trim: true, lowercase: true, required: true, maxlength: 100 },
  },
  { _id: false },
);

const shoppingPreferencesSchema = new Schema(
  {
    budgetPesewas: { type: Number, min: 0, max: 1_000_000_000 },
  },
  { _id: false },
);

const clarificationPurposes = [
  'budget',
  'intended_use',
  'product',
  'category',
  'preferences',
  'delivery_location',
] as const;

const chatConversationSchema = new Schema(
  {
    _id: { type: String, default: randomUUID },
    ownerHash: { type: String, required: true, minlength: 64, maxlength: 64, index: true },
    messages: { type: [chatMessageSchema], default: [] },
    lastShownProducts: { type: [shownProductReferenceSchema], default: [] },
    // Kept for conversations created by the first chatbot release. New writes
    // also retain this field while readers prefer the positional snapshots.
    lastShownProductIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
    shoppingPreferences: { type: shoppingPreferencesSchema, default: () => ({}) },
    pendingClarificationPurpose: { type: String, enum: clarificationPurposes, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

chatConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
chatConversationSchema.index({ ownerHash: 1, updatedAt: -1 });

export const ChatConversationModel = ((models.ChatConversation as Model<any> | undefined) ??
  model<any>('ChatConversation', chatConversationSchema)) as Model<any>;
export default ChatConversationModel;

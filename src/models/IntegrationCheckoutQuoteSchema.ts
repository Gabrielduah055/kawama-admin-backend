import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

const quoteItemSchema = new Schema(
  {
    productId: { type: String, trim: true, required: true },
    slug: { type: String, trim: true, required: true },
    name: { type: String, trim: true, required: true, maxlength: 120 },
    image: {
      src: { type: String, trim: true },
      alt: { type: String, trim: true, maxlength: 200 },
    },
    unitPricePesewas: { type: Number, min: 0, required: true },
    quantity: { type: Number, min: 1, max: 20, required: true },
    lineTotalPesewas: { type: Number, min: 0, required: true },
  },
  { _id: false },
);

const quoteCustomerSchema = new Schema(
  {
    fullName: { type: String, trim: true, required: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, required: true, maxlength: 254 },
    whatsappNumber: { type: String, trim: true, required: true, maxlength: 16 },
    deliveryAddress: { type: String, trim: true, required: true, maxlength: 500 },
    whatsappConsent: { type: Boolean, required: true },
  },
  { _id: false },
);

const integrationCheckoutQuoteSchema = new Schema(
  {
    businessId: { type: String, trim: true, required: true, index: true, immutable: true },
    customerKey: { type: String, trim: true, required: true, index: true, immutable: true },
    customer: { type: quoteCustomerSchema, required: true, immutable: true },
    orderNotes: { type: String, trim: true, default: '', maxlength: 500, immutable: true },
    items: {
      type: [quoteItemSchema],
      required: true,
      immutable: true,
      validate: {
        validator: (items: unknown[]) => items.length > 0,
        message: 'A quote must contain at least one item.',
      },
    },
    currency: { type: String, enum: ['GHS'], default: 'GHS', immutable: true },
    subtotalPesewas: { type: Number, min: 0, required: true, immutable: true },
    totalPesewas: { type: Number, min: 0, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    checkoutState: { type: String, enum: ['open', 'bound'], default: 'open', required: true },
    checkoutKeyHash: { type: String, trim: true, select: false },
    integrationSessionId: { type: String, trim: true },
    consumedAt: { type: Date },
    consumedByOrderId: { type: Schema.Types.ObjectId, ref: 'Order' },
  },
  { timestamps: true, versionKey: false },
);

integrationCheckoutQuoteSchema.index({ businessId: 1, customerKey: 1, createdAt: -1 });
integrationCheckoutQuoteSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { checkoutState: 'open' } },
);
integrationCheckoutQuoteSchema.index({ checkoutKeyHash: 1 }, { unique: true, sparse: true });
integrationCheckoutQuoteSchema.index({ integrationSessionId: 1 }, { unique: true, sparse: true });

export const IntegrationCheckoutQuoteModel = ((models.IntegrationCheckoutQuote as Model<any> | undefined) ??
  model<any>('IntegrationCheckoutQuote', integrationCheckoutQuoteSchema)) as Model<any>;
export default IntegrationCheckoutQuoteModel;

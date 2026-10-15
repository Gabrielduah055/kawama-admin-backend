import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

export const paymentStatuses = ['pending', 'paid', 'failed', 'refunded', 'needs_attention'] as const;
export const fulfillmentStatuses = [
  'awaiting_payment',
  'paid_awaiting_delivery',
  'processing',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'needs_attention',
] as const;
export const deliveryFeeStatuses = ['not_quoted', 'quoted', 'collected', 'waived'] as const;
export const stockReservationStatuses = ['active', 'committed', 'released'] as const;

const orderCustomerSchema = new Schema(
  {
    fullName: { type: String, trim: true, required: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, required: true, maxlength: 254 },
    whatsappNumber: { type: String, trim: true, required: true, maxlength: 16 },
    deliveryAddress: { type: String, trim: true, required: true, maxlength: 500 },
    whatsappConsent: { type: Boolean, required: true },
  },
  { _id: false },
);

const orderItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
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

const receiptSchema = new Schema(
  {
    number: { type: String, trim: true },
    url: { type: String, trim: true },
    generatedAt: { type: Date },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    orderNumber: { type: String, trim: true, uppercase: true, required: true, immutable: true },
    customerRecord: { type: Schema.Types.ObjectId, ref: 'Customer', index: true },
    customer: { type: orderCustomerSchema, required: true },
    orderNotes: { type: String, trim: true, default: '', maxlength: 500 },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (items: unknown[]) => items.length > 0,
        message: 'An order must contain at least one item.',
      },
    },
    currency: { type: String, enum: ['GHS'], default: 'GHS', immutable: true },
    subtotalPesewas: { type: Number, min: 0, required: true },
    productPaymentTotalPesewas: { type: Number, min: 0, required: true },
    deliveryFeePesewas: { type: Number, min: 0, default: null },
    deliveryPaymentMethod: { type: String, enum: ['pay_on_delivery'], default: 'pay_on_delivery' },
    deliveryFeeStatus: { type: String, enum: deliveryFeeStatuses, default: 'not_quoted', index: true },
    paymentProvider: { type: String, enum: ['paystack'], default: 'paystack' },
    paymentReference: { type: String, trim: true },
    paystackTransactionId: { type: String, trim: true },
    paymentStatus: { type: String, enum: paymentStatuses, default: 'pending', index: true },
    fulfillmentStatus: { type: String, enum: fulfillmentStatuses, default: 'awaiting_payment', index: true },
    idempotencyKeyHash: { type: String, required: true, immutable: true, select: false },
    stockReservationStatus: { type: String, enum: stockReservationStatuses, default: 'active', index: true },
    stockReservationExpiresAt: { type: Date },
    inventoryCommittedAt: { type: Date },
    paymentVerifiedAt: { type: Date },
    paidAt: { type: Date },
    deliveredAt: { type: Date },
    cancelledAt: { type: Date },
    receipt: { type: receiptSchema },
  },
  { timestamps: true, versionKey: false },
);

orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ paymentReference: 1 }, { unique: true, sparse: true });
orderSchema.index({ idempotencyKeyHash: 1 }, { unique: true });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ paymentStatus: 1, fulfillmentStatus: 1, createdAt: -1 });
orderSchema.index({ 'customer.whatsappNumber': 1, createdAt: -1 });
orderSchema.index({ 'customer.email': 1, createdAt: -1 });

export const OrderModel = ((models.Order as Model<any> | undefined) ??
  model<any>('Order', orderSchema)) as Model<any>;
export default OrderModel;

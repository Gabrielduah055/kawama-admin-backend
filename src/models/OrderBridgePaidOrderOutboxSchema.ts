import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;
const MAX_MONEY_PESEWAS = 10_000_000_000_000;

const integerField = (minimum: number, maximum: number) => ({
  type: Number,
  required: true,
  min: minimum,
  max: maximum,
  validate: { validator: Number.isInteger, message: 'Value must be an integer.' },
});

export const orderBridgePaidOrderOutboxStatuses = [
  'pending',
  'delivering',
  'delivered',
  'failed',
] as const;

const paidOrderItemSchema = new Schema(
  {
    externalProductId: { type: String, required: true, trim: true, maxlength: 160 },
    name: { type: String, required: true, trim: true, maxlength: 300 },
    quantity: integerField(1, 10_000),
    unitPricePesewas: integerField(0, MAX_MONEY_PESEWAS),
    lineTotalPesewas: integerField(0, MAX_MONEY_PESEWAS),
  },
  { _id: false },
);

const paidOrderCustomerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    phone: { type: String, required: true, trim: true, minlength: 7, maxlength: 32 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    whatsappConsent: { type: Boolean, required: true },
  },
  { _id: false },
);

const paidOrderDeliverySchema = new Schema(
  {
    recipientName: { type: String, trim: true, maxlength: 200 },
    recipientPhone: { type: String, trim: true, maxlength: 32 },
    addressLine1: { type: String, trim: true, maxlength: 300 },
    addressLine2: { type: String, trim: true, maxlength: 300 },
    city: { type: String, trim: true, maxlength: 120 },
    region: { type: String, trim: true, maxlength: 120 },
    postalCode: { type: String, trim: true, maxlength: 32 },
    countryCode: { type: String, trim: true, uppercase: true, match: /^[A-Z]{2}$/ },
    instructions: { type: String, trim: true, maxlength: 1_000 },
    chargeStatus: { type: String, enum: ['to_be_arranged'], required: true },
  },
  { _id: false },
);

const paidOrderSchema = new Schema(
  {
    externalOrderId: { type: String, required: true, trim: true, maxlength: 160 },
    orderNumber: { type: String, required: true, trim: true, maxlength: 120 },
    paymentReference: { type: String, required: true, trim: true, maxlength: 200 },
    paidAt: { type: Date, required: true },
    currency: { type: String, enum: ['GHS'], required: true },
    productPaymentTotalPesewas: integerField(0, MAX_MONEY_PESEWAS),
    items: {
      type: [paidOrderItemSchema],
      required: true,
      validate: {
        validator: (items: unknown[]) => items.length >= 1 && items.length <= 100,
        message: 'Paid-order events require between 1 and 100 items.',
      },
    },
    customer: { type: paidOrderCustomerSchema, required: true },
    delivery: { type: paidOrderDeliverySchema, required: true },
  },
  { _id: false },
);

paidOrderItemSchema.path('lineTotalPesewas').validate(function validLineTotal(value: number) {
  const item = this as any;
  const calculated = item.quantity * item.unitPricePesewas;
  return Number.isSafeInteger(calculated) && value === calculated;
}, 'lineTotalPesewas must equal quantity multiplied by unitPricePesewas.');

paidOrderSchema.path('productPaymentTotalPesewas').validate(function validOrderTotal(value: number) {
  const order = this as any;
  const total = order.items.reduce((sum: number, item: any) => sum + item.lineTotalPesewas, 0);
  return Number.isSafeInteger(total) && value === total;
}, 'productPaymentTotalPesewas must equal the sum of item line totals.');

const paidOrderEventSchema = new Schema(
  {
    type: { type: String, enum: ['order.paid'], required: true },
    eventId: { type: String, required: true, trim: true, maxlength: 160 },
    occurredAt: { type: Date, required: true },
    order: { type: paidOrderSchema, required: true },
  },
  { _id: false },
);

const orderBridgePaidOrderOutboxSchema = new Schema(
  {
    destinationBusinessId: {
      type: String,
      required: true,
      trim: true,
      match: /^[a-fA-F0-9]{24}$/,
      immutable: true,
    },
    eventId: { type: String, required: true, trim: true, maxlength: 160, immutable: true },
    occurredAt: { type: Date, required: true, immutable: true },
    payload: { type: paidOrderEventSchema, required: true, immutable: true },
    status: {
      type: String,
      enum: orderBridgePaidOrderOutboxStatuses,
      required: true,
      default: 'pending',
      index: true,
    },
    attemptCount: { type: Number, min: 0, required: true, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    leaseId: { type: String, trim: true, select: false },
    leaseExpiresAt: { type: Date },
    lastAttemptAt: { type: Date },
    lastErrorAt: { type: Date },
    lastErrorCode: { type: String, trim: true, maxlength: 100 },
    lastHttpStatus: { type: Number, min: 100, max: 599 },
    deliveredAt: { type: Date },
    createdAt: { type: Date, required: true, immutable: true },
  },
  { versionKey: false, strict: true },
);

orderBridgePaidOrderOutboxSchema.path('eventId').validate(function matchingPayloadEventId(value: string) {
  return (this as any).payload?.eventId === value;
}, 'Outbox eventId must match the payload eventId.');

orderBridgePaidOrderOutboxSchema.path('occurredAt').validate(function matchingOccurredAt(value: Date) {
  const payloadOccurredAt = (this as any).payload?.occurredAt;
  return payloadOccurredAt instanceof Date && payloadOccurredAt.getTime() === value.getTime();
}, 'Outbox occurredAt must match the payload occurredAt.');

orderBridgePaidOrderOutboxSchema.index(
  { destinationBusinessId: 1, eventId: 1 },
  { unique: true, name: 'orderbridge_outbox_business_event_unique' },
);
orderBridgePaidOrderOutboxSchema.index(
  { destinationBusinessId: 1, 'payload.order.externalOrderId': 1 },
  { unique: true, name: 'orderbridge_outbox_business_order_unique' },
);
orderBridgePaidOrderOutboxSchema.index(
  { destinationBusinessId: 1, 'payload.order.paymentReference': 1 },
  { unique: true, name: 'orderbridge_outbox_business_payment_unique' },
);
orderBridgePaidOrderOutboxSchema.index(
  { destinationBusinessId: 1, status: 1, nextAttemptAt: 1, leaseExpiresAt: 1, createdAt: 1 },
  { name: 'orderbridge_outbox_delivery_claim' },
);

export const OrderBridgePaidOrderOutboxModel = (
  (models.OrderBridgePaidOrderOutbox as Model<any> | undefined)
  ?? model<any>('OrderBridgePaidOrderOutbox', orderBridgePaidOrderOutboxSchema)
) as Model<any>;

export async function ensureOrderBridgePaidOrderOutboxStorage(): Promise<void> {
  await OrderBridgePaidOrderOutboxModel.createCollection();
  await OrderBridgePaidOrderOutboxModel.createIndexes();
}

export default OrderBridgePaidOrderOutboxModel;

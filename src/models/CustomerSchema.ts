import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

const customerSchema = new Schema(
  {
    fullName: { type: String, trim: true, required: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, required: true, maxlength: 254, index: true },
    whatsappNumber: { type: String, trim: true, required: true, maxlength: 16, index: true },
    whatsappConsentAt: { type: Date, required: true },
    defaultDeliveryAddress: { type: String, trim: true, required: true, maxlength: 500 },
    paidOrderCount: { type: Number, min: 0, default: 0 },
    lifetimeValuePesewas: { type: Number, min: 0, default: 0 },
    lastPaidOrderAt: { type: Date },
    status: { type: String, enum: ['active', 'blocked'], default: 'active', index: true },
  },
  { timestamps: true, versionKey: false },
);

customerSchema.index({ whatsappNumber: 1, email: 1 });
customerSchema.index({ lastPaidOrderAt: -1 });

export const CustomerModel = ((models.Customer as Model<any> | undefined) ??
  model<any>('Customer', customerSchema)) as Model<any>;
export default CustomerModel;

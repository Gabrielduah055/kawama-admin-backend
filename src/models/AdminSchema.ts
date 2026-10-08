import mongoose, { type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

const adminSchema = new Schema(
  {
    email: { type: String, trim: true, lowercase: true, required: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['owner'], default: 'owner' },
    active: { type: Boolean, default: true, index: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

adminSchema.index({ email: 1 }, { unique: true });

export const AdminModel = ((models.Admin as Model<any> | undefined) ?? model<any>('Admin', adminSchema)) as Model<any>;
export default AdminModel;

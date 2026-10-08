import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { AppError } from '../errors/AppError.js';
import { getEnvironment } from '../config/environment.js';
import { AdminModel } from '../models/AdminSchema.js';

export interface AdminIdentity {
  uid: string;
  email: string;
}

export type AdminTokenVerifier = (token: string) => Promise<AdminIdentity>;

const issuer = 'kawama-api';
const audience = 'kawama-admin';

function jwtConfiguration(): { secret: string; expiresIn: number } {
  const environment = getEnvironment();
  if (!environment.JWT_SECRET) throw new AppError(503, 'AUTH_NOT_CONFIGURED', 'JWT authentication is not configured.');
  return { secret: environment.JWT_SECRET, expiresIn: environment.JWT_EXPIRES_IN };
}

export async function authenticateAdmin(email: string, password: string): Promise<{
  token: string;
  expiresIn: number;
  admin: { id: string; email: string; role: 'owner' };
}> {
  const normalizedEmail = email.trim().toLowerCase();
  const admin = await AdminModel.findOne({ email: normalizedEmail, active: true }).select('+passwordHash');
  const validPassword = admin ? await bcrypt.compare(password, admin.passwordHash) : false;
  if (!admin || !validPassword) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'The login details are incorrect.');
  }

  const configuration = jwtConfiguration();
  const token = jwt.sign(
    { email: admin.email, role: admin.role },
    configuration.secret,
    { subject: String(admin._id), issuer, audience, expiresIn: configuration.expiresIn },
  );
  await AdminModel.updateOne({ _id: admin._id }, { lastLoginAt: new Date() });
  return {
    token,
    expiresIn: configuration.expiresIn,
    admin: { id: String(admin._id), email: admin.email, role: admin.role },
  };
}

export const verifyDatabaseAdminToken: AdminTokenVerifier = async (token) => {
  const configuration = jwtConfiguration();

  try {
    const decoded = jwt.verify(token, configuration.secret, { issuer, audience }) as JwtPayload;
    if (!decoded.sub) throw new Error('Missing token subject.');
    const admin = await AdminModel.findOne({ _id: decoded.sub, active: true }).lean();
    if (!admin) throw new AppError(401, 'INVALID_ADMIN_TOKEN', 'The administrator token is invalid or expired.');
    return { uid: String(admin._id), email: admin.email };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, 'INVALID_ADMIN_TOKEN', 'The administrator token is invalid or expired.');
  }
};

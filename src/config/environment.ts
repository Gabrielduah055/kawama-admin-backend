import 'dotenv/config';
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  MONGODB_URI: z.string().trim().optional(),
  MONGODB_DNS_SERVERS: z.string().trim().optional(),
  FRONTEND_ORIGINS: z.string().default('http://localhost:4200'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ADMIN_EMAIL: z.string().trim().min(3).optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  JWT_SECRET: z.string().min(32).optional(),
  JWT_EXPIRES_IN: z.coerce.number().int().positive().max(604_800).default(43_200),
  CLOUDINARY_CLOUD_NAME: z.string().trim().optional(),
  CLOUDINARY_API_KEY: z.string().trim().optional(),
  CLOUDINARY_API_SECRET: z.string().trim().optional(),
  CLOUDINARY_FOLDER: z.string().trim().regex(/^[a-zA-Z0-9_-]+$/).default('kawama'),
  SEED_ASSET_DIR: z.string().trim().default('../kawama/public/images'),
});

export type Environment = z.infer<typeof environmentSchema>;
let cachedEnvironment: Environment | undefined;

export const getEnvironment = (): Environment => {
  cachedEnvironment ??= environmentSchema.parse(process.env);
  return cachedEnvironment;
};

export const requireEnvironment = <K extends keyof Environment>(key: K): NonNullable<Environment[K]> => {
  const value = getEnvironment()[key];
  if (value === undefined || value === '') throw new Error(`Missing required environment variable: ${key}`);
  return value as NonNullable<Environment[K]>;
};

export const resetEnvironmentForTests = (): void => {
  cachedEnvironment = undefined;
};

import 'dotenv/config';
import { z } from 'zod';

export const DEFAULT_OPENROUTER_MODEL = 'google/gemma-4-31b-it:free';

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalContactEmail = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().email().optional(),
);
const optionalContactUrl = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().url().optional(),
);
const optionalContactText = (maximum: number) => z.preprocess(
  emptyStringToUndefined,
  z.string().trim().max(maximum).optional(),
);

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
  // Payment settings are validated by the Paystack gateway so a bad or missing
  // payment configuration cannot prevent catalog-only routes from starting.
  PAYSTACK_SECRET_KEY: z.string().trim().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().trim().optional(),
  PAYSTACK_CALLBACK_URL: z.string().trim().optional(),
  PAYSTACK_BASE_URL: z.string().trim().default('https://api.paystack.co'),
  AI_CHAT_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  OPENROUTER_API_KEY: z.string().trim().optional(),
  OPENROUTER_MODEL: z.preprocess(
    emptyStringToUndefined,
    z.string().trim().min(1).default(DEFAULT_OPENROUTER_MODEL),
  ),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(60_000).default(30_000),
  AI_CHAT_CONVERSATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  ORDERBRIDGE_API_KEY: z.preprocess(
    emptyStringToUndefined,
    z.string().trim().min(32).max(512).optional(),
  ),
  STOREFRONT_PRODUCT_URL_TEMPLATE: optionalContactText(2_000),
  STORE_CONTACT_EMAIL: optionalContactEmail,
  STORE_CONTACT_PHONE: optionalContactText(40),
  STORE_CONTACT_WHATSAPP_URL: optionalContactUrl,
  STORE_DELIVERY_POLICY: optionalContactText(2_000),
  STORE_PAYMENT_POLICY: optionalContactText(2_000),
  STORE_RETURN_POLICY: optionalContactText(2_000),
  SEED_ASSET_DIR: z.string().trim().default('../kawama/public/images'),
  SEED_ASSET_BASE_URL: z.string().trim().url().optional(),
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

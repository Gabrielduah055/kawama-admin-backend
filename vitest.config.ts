import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CLOUDINARY_FOLDER: 'kawama',
      SEED_ASSET_BASE_URL: 'https://raw.githubusercontent.com/Gabrielduah055/Kawama/9306e51587963f5f4616eab6db7c49d1e4df0ea0/public/images',
      JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters',
      JWT_EXPIRES_IN: '43200',
    },
  },
});

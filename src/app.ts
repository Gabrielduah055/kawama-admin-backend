import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { getEnvironment } from './config/environment.js';
import { databaseIsReady } from './config/mongodb.js';
import { AppError } from './errors/AppError.js';
import { createAdministratorAuthentication } from './middlewares/auth.js';
import { errorHandler, notFoundHandler } from './middlewares/errors.js';
import { requestContext } from './middlewares/requestContext.js';
import { openApiDocument } from './openapi.js';
import { createAdminRouter } from './route/adminRouter.js';
import { authRouter } from './route/authRouter.js';
import { createProductRouter } from './route/productRouter.js';
import { publicRouter } from './route/publicRouter.js';
import { verifyDatabaseAdminToken, type AdminTokenVerifier } from './services/auth.service.js';
import { cloudinaryMediaService, type MediaService } from './services/cloudinary.service.js';

export interface ApplicationDependencies {
  verifyAdminToken?: AdminTokenVerifier;
  mediaService?: MediaService;
}

export function createApp(dependencies: ApplicationDependencies = {}) {
  const environment = getEnvironment();
  const app = express();
  const allowedOrigins = new Set(
    environment.FRONTEND_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  );
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestContext);
  app.use(helmet({
    contentSecurityPolicy: false,
    ...(environment.NODE_ENV === 'production' ? {} : { strictTransportSecurity: false }),
  }));
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) callback(null, true);
        else callback(new AppError(403, 'CORS_ORIGIN_DENIED', 'This origin is not allowed to call the API.'));
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      maxAge: 86_400,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: environment.NODE_ENV === 'test' ? 10_000 : 300,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (request) => request.path.startsWith('/health/'),
      handler: (request, response) => {
        response.status(429).json({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.',
            requestId: request.id,
          },
        });
      },
    }),
  );

  app.get('/', (_request, response) => response.status(200).json({ status: 'ok', message: 'Kawama API is running' }));
  app.get('/health/live', (_request, response) => response.json({ data: { status: 'ok' } }));
  app.get('/health/ready', (_request, response) => {
    const ready = databaseIsReady();
    response.status(ready ? 200 : 503).json({ data: { status: ready ? 'ready' : 'not_ready', database: ready } });
  });
  app.get('/openapi.json', (_request, response) => response.json(openApiDocument));

  const adminMiddleware = createAdministratorAuthentication(dependencies.verifyAdminToken ?? verifyDatabaseAdminToken);

  app.use('/api/admin', authRouter);
  app.use('/api/product', createProductRouter(adminMiddleware));
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1', publicRouter);
  app.use(
    '/api/v1/admin',
    adminMiddleware,
    createAdminRouter(dependencies.mediaService ?? cloudinaryMediaService),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

import cors, { type CorsOptions, type CorsOptionsDelegate } from 'cors';
import express, { type Request } from 'express';
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
import { createCheckoutRouter, createPaystackWebhookRouter } from './route/checkoutRouter.js';
import { createProductRouter } from './route/productRouter.js';
import { publicRouter } from './route/publicRouter.js';
import { verifyDatabaseAdminToken, type AdminTokenVerifier } from './services/auth.service.js';
import { cloudinaryMediaService, type MediaService } from './services/cloudinary.service.js';
import { paystackGateway, type PaystackGateway } from './services/paystack.service.js';

export interface ApplicationDependencies {
  verifyAdminToken?: AdminTokenVerifier;
  mediaService?: MediaService;
  paystackGateway?: PaystackGateway;
}

const corsOptions: Omit<CorsOptions, 'origin'> = {
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Paystack-Signature', 'X-Request-Id'],
  maxAge: 86_400,
};

function isPublicStorefrontRequest(request: Request): boolean {
  const method = request.method === 'OPTIONS'
    ? request.header('access-control-request-method')?.toUpperCase() ?? request.method
    : request.method;
  const { path } = request;
  if (method === 'GET' && (path === '/' || path.startsWith('/health/') || path === '/openapi.json')) return true;
  if (method === 'GET' && (path === '/api/product' || path.startsWith('/api/product/'))) return true;
  if (method === 'GET' && (path === '/api/v1/categories' || path === '/api/v1/products' || path.startsWith('/api/v1/products/'))) return true;
  if (method === 'GET' && path.startsWith('/api/v1/checkout/sessions/')) return true;
  if (method === 'POST' && path === '/api/v1/checkout/sessions') return true;
  return method === 'POST' && /^\/api\/v1\/products\/[^/]+\/reviews$/.test(path);
}

export function createApp(dependencies: ApplicationDependencies = {}) {
  const environment = getEnvironment();
  const app = express();
  const allowedOrigins = new Set(
    environment.FRONTEND_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  );
  const corsDelegate: CorsOptionsDelegate<Request> = (request, callback) => {
    const publicStorefrontRequest = isPublicStorefrontRequest(request);
    callback(null, {
      ...corsOptions,
      origin(origin, originCallback) {
        if (publicStorefrontRequest || !origin || allowedOrigins.has(origin)) originCallback(null, true);
        else originCallback(new AppError(403, 'CORS_ORIGIN_DENIED', 'This origin is not allowed to call the API.'));
      },
    });
  };
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestContext);
  app.use(helmet({
    contentSecurityPolicy: false,
    ...(environment.NODE_ENV === 'production' ? {} : { strictTransportSecurity: false }),
  }));
  app.use(cors(corsDelegate));
  app.use(express.json({
    limit: '1mb',
    verify(request, _response, buffer) {
      const expressRequest = request as Request;
      if (expressRequest.originalUrl.startsWith('/api/v1/webhooks/paystack')) {
        expressRequest.rawBody = Buffer.from(buffer);
      }
    },
  }));
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
  const selectedPaystackGateway = dependencies.paystackGateway ?? paystackGateway;
  app.use('/api/v1/checkout', createCheckoutRouter(selectedPaystackGateway));
  app.use('/api/v1/webhooks', createPaystackWebhookRouter(selectedPaystackGateway));
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

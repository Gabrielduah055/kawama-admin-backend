import 'dotenv/config';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/mongodb.js';
import { getEnvironment } from './config/environment.js';
import {
  startOrderBridgePaidOrderEventsWorker,
  validateOrderBridgePaidOrderEventsConfiguration,
  type OrderBridgePaidOrderEventsWorker,
} from './services/orderbridge-paid-order-events.service.js';
import { logger } from './utils/logger.js';

export interface ServerDependencies {
  connect?: () => Promise<void>;
  buildApp?: typeof createApp;
  port?: number;
  registerSignals?: boolean;
  startPaidOrderEventsWorker?: () => OrderBridgePaidOrderEventsWorker;
}

export const startServer = async (dependencies: ServerDependencies = {}): Promise<Server> => {
  const environment = getEnvironment();
  const connect = dependencies.connect ?? connectDatabase;
  const buildApp = dependencies.buildApp ?? createApp;
  const port = dependencies.port ?? environment.PORT;
  const startPaidOrderEventsWorker = dependencies.startPaidOrderEventsWorker
    ?? startOrderBridgePaidOrderEventsWorker;

  validateOrderBridgePaidOrderEventsConfiguration();
  await connect();
  const paidOrderEventsWorker = startPaidOrderEventsWorker();
  const server = buildApp().listen(port, () => logger.info('server_listening', { port }));

  if (dependencies.registerSignals !== false) {
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('server_shutdown_started', { signal });
      const timeout = setTimeout(() => {
        logger.error('server_shutdown_timeout');
        process.exitCode = 1;
      }, 10_000);
      timeout.unref();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await paidOrderEventsWorker.stop();
      await disconnectDatabase();
      clearTimeout(timeout);
      logger.info('server_shutdown_complete');
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
  }

  return server;
};

void startServer().catch((error: unknown) => {
  logger.error('server_startup_failed', { errorName: error instanceof Error ? error.name : 'UnknownError' });
  process.exitCode = 1;
});

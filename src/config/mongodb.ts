import { setServers } from 'node:dns';
import mongoose from 'mongoose';
import { getEnvironment, requireEnvironment } from './environment.js';
import { CustomerModel } from '../models/CustomerSchema.js';
import { OrderModel } from '../models/OrderSchema.js';
import { PaymentAttemptModel } from '../models/PaymentAttemptSchema.js';
import { logger } from '../utils/logger.js';

export const connectDatabase = async (uri = requireEnvironment('MONGODB_URI')): Promise<void> => {
  if (mongoose.connection.readyState === 1) return;
  const configuredDnsServers = getEnvironment().MONGODB_DNS_SERVERS
    ?.split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  if (configuredDnsServers?.length) setServers(configuredDnsServers);
  await mongoose.connect(uri, {
    autoIndex: process.env.NODE_ENV !== 'production',
    serverSelectionTimeoutMS: 10_000,
  });
  if (getEnvironment().NODE_ENV === 'production') {
    await Promise.all([
      CustomerModel.createIndexes(),
      OrderModel.createIndexes(),
      PaymentAttemptModel.createIndexes(),
    ]);
  }
  logger.info('mongodb_connected');
};

export const disconnectDatabase = async (): Promise<void> => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
};

export const databaseIsReady = (): boolean => mongoose.connection.readyState === 1;

export default connectDatabase;

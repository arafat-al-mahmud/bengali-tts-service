import express, { type Express } from 'express';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Config } from './config.js';
import type { PrismaClient } from './lib/prisma.js';
import type { Redis } from './lib/redis.js';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  config: Config;
  prisma: PrismaClient;
  redis: Redis;
  s3: S3Client;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use(healthRouter(deps));

  return app;
}

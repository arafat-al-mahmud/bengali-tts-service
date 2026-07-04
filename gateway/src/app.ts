import express, { type Express } from 'express';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Config } from './config.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import type { PrismaClient } from './lib/prisma.js';
import type { TtsQueue } from './lib/queue.js';
import type { Redis } from './lib/redis.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { jobsRouter } from './routes/jobs.js';
import { keysRouter } from './routes/keys.js';
import { meRouter } from './routes/me.js';

export interface AppDeps {
  config: Config;
  prisma: PrismaClient;
  redis: Redis;
  s3: S3Client;
  queue: TtsQueue;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use(healthRouter(deps));
  app.use(authRouter(deps));
  app.use(keysRouter(deps));
  app.use(meRouter(deps));
  app.use(jobsRouter(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import type { Metrics } from './lib/metrics.js';
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
  logger: Logger;
  metrics: Metrics;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use(
    pinoHttp({
      logger: deps.logger,
      // The request id doubles as the job's correlation id and is echoed
      // to the client, so one grep ties a response, its gateway log lines,
      // and the worker's synthesis logs together.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming !== '' ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Credentials must never reach the log stream.
      redact: ['req.headers.authorization'],
    }),
  );
  app.use(deps.metrics.httpMiddleware);

  // Unauthenticated by design: meant for an internal scraper, and it
  // exposes no per-user data. See docs/observability.md.
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', deps.metrics.registry.contentType);
    res.send(await deps.metrics.registry.metrics());
  });

  app.use(healthRouter(deps));
  app.use(authRouter(deps));
  app.use(keysRouter(deps));
  app.use(meRouter(deps));
  app.use(jobsRouter(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

import { Effect } from 'effect';
import { pino, type Logger } from 'pino';
import { inject } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createMetrics } from '../../src/lib/metrics.js';
import { createPrisma } from '../../src/lib/prisma.js';
import { createTtsQueue } from '../../src/lib/queue.js';
import { createRedis } from '../../src/lib/redis.js';
import { createSseHub } from '../../src/lib/sse.js';
import { createS3, ensureBucket, StorageService } from '../../src/lib/storage.js';
import { makeRuntime } from '../../src/lib/tracing.js';

export interface TestContext {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  close: () => Promise<void>;
}

export async function createTestContext(
  overrides: Record<string, string> = {},
  extras: { logger?: Logger } = {},
): Promise<TestContext> {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: inject('DATABASE_URL'),
    REDIS_URL: inject('REDIS_URL'),
    S3_ENDPOINT: inject('S3_ENDPOINT'),
    S3_ACCESS_KEY: inject('S3_ACCESS_KEY'),
    S3_SECRET_KEY: inject('S3_SECRET_KEY'),
    S3_BUCKET: inject('S3_BUCKET'),
    ...overrides,
  });

  const prisma = createPrisma(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const s3 = createS3(config);
  const queue = createTtsQueue(redis, config.TTS_QUEUE_NAME);
  await Effect.runPromise(
    ensureBucket(config.S3_BUCKET).pipe(Effect.provideService(StorageService, s3)),
  );

  const logger = extras.logger ?? pino({ level: 'silent' });
  const metrics = createMetrics(prisma, queue);
  const sse = createSseHub();
  // No collector under test: spans are recorded and go nowhere.
  const runtime = makeRuntime(config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const deps: AppDeps = { config, runtime, prisma, redis, s3, queue, logger, metrics, sse };
  return {
    app: createApp(deps),
    deps,
    close: async () => {
      sse.closeAll();
      await runtime.dispose();
      await queue.close();
      await prisma.$disconnect();
      redis.disconnect();
      s3.destroy();
    },
  };
}

import { Effect } from 'effect';
import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createMetrics } from './lib/metrics.js';
import { createPrisma } from './lib/prisma.js';
import { createTtsQueue } from './lib/queue.js';
import { createRedis } from './lib/redis.js';
import { gracefulShutdown } from './lib/shutdown.js';
import { createSseHub } from './lib/sse.js';
import { createS3, ensureBucket, StorageService } from './lib/storage.js';
import { makeRuntime } from './lib/tracing.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

// Built before anything else runs, so every Effect in the process shares
// one tracer and a request's spans land in one trace.
const runtime = makeRuntime(config.OTEL_EXPORTER_OTLP_ENDPOINT);

const prisma = createPrisma(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);
const s3 = createS3(config);
const queue = createTtsQueue(redis, config.TTS_QUEUE_NAME);

// Storage may still be accepting connections when we get here; the retry
// inside waits it out rather than letting a boot race kill the process.
await Effect.runPromise(
  ensureBucket(config.S3_BUCKET).pipe(Effect.provideService(StorageService, s3)),
);

const metrics = createMetrics(prisma, queue);
const sse = createSseHub();
const app = createApp({ config, runtime, prisma, redis, s3, queue, logger, metrics, sse });

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'gateway listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  // Event streams are long-lived; end them first or the drain below would
  // wait on them until the failsafe timer.
  sse.closeAll();
  gracefulShutdown(
    server,
    async () => {
      // Before the connections go: disposing flushes spans still batched
      // in memory, so the last requests before a deploy are not lost.
      await runtime.dispose();
      await queue.close();
      await prisma.$disconnect();
      redis.disconnect();
      s3.destroy();
      logger.info('shutdown complete');
    },
    (code) => process.exit(code),
  );
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

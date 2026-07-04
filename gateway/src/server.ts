import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createMetrics } from './lib/metrics.js';
import { createPrisma } from './lib/prisma.js';
import { createTtsQueue } from './lib/queue.js';
import { createRedis } from './lib/redis.js';
import { gracefulShutdown } from './lib/shutdown.js';
import { createS3, ensureBucket } from './lib/storage.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

const prisma = createPrisma(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);
const s3 = createS3(config);
const queue = createTtsQueue(redis, config.TTS_QUEUE_NAME);

await ensureBucket(s3, config.S3_BUCKET);

const metrics = createMetrics(prisma, queue);
const app = createApp({ config, prisma, redis, s3, queue, logger, metrics });

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'gateway listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  gracefulShutdown(
    server,
    async () => {
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

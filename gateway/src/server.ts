import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPrisma } from './lib/prisma.js';
import { createRedis } from './lib/redis.js';
import { createS3, ensureBucket } from './lib/storage.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

const prisma = createPrisma(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);
const s3 = createS3(config);

await ensureBucket(s3, config.S3_BUCKET);

const app = createApp({ config, prisma, redis, s3 });

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'gateway listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    void (async () => {
      await prisma.$disconnect();
      redis.disconnect();
      s3.destroy();
      logger.info('shutdown complete');
      process.exit(0);
    })();
  });
  // Failsafe: never hang forever on stuck connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

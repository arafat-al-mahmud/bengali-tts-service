import { inject } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPrisma } from '../../src/lib/prisma.js';
import { createRedis } from '../../src/lib/redis.js';
import { createS3, ensureBucket } from '../../src/lib/storage.js';

export interface TestContext {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  close: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: inject('DATABASE_URL'),
    REDIS_URL: inject('REDIS_URL'),
    S3_ENDPOINT: inject('S3_ENDPOINT'),
    S3_ACCESS_KEY: inject('S3_ACCESS_KEY'),
    S3_SECRET_KEY: inject('S3_SECRET_KEY'),
    S3_BUCKET: inject('S3_BUCKET'),
  });

  const prisma = createPrisma(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const s3 = createS3(config);
  await ensureBucket(s3, config.S3_BUCKET);

  const deps: AppDeps = { config, prisma, redis, s3 };
  return {
    app: createApp(deps),
    deps,
    close: async () => {
      await prisma.$disconnect();
      redis.disconnect();
      s3.destroy();
    },
  };
}

import { Redis } from 'ioredis';

export function createRedis(redisUrl: string): Redis {
  // maxRetriesPerRequest: null is required by BullMQ and keeps health checks
  // from throwing while Redis is briefly unavailable.
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export type { Redis };

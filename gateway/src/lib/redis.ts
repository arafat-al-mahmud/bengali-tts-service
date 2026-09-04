import { Context } from 'effect';
import { Redis } from 'ioredis';

export function createRedis(redisUrl: string): Redis {
  // maxRetriesPerRequest: null is required by BullMQ and keeps health checks
  // from throwing while Redis is briefly unavailable.
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

/**
 * The name Effect code uses to ask for Redis.
 *
 * Code that needs the connection declares this instead of taking it as an
 * argument, which puts the dependency in the type: an Effect that reaches
 * for Redis cannot be run until someone supplies one.
 */
export class RedisService extends Context.Tag('RedisService')<RedisService, Redis>() {}

export type { Redis };

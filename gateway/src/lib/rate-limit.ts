import { Effect } from 'effect';
import { RateLimited } from './errors.js';
import { RedisService } from './redis.js';

/**
 * Token bucket, evaluated atomically inside Redis so concurrent requests
 * cannot double-spend. The bucket holds up to a minute's worth of tokens
 * (allowing a burst after idle time) and refills continuously. Redis's own
 * clock is the time source, so every gateway replica shares one notion of
 * "now" regardless of host clock skew.
 */
const TAKE_TOKEN = `
local capacity = tonumber(ARGV[1])
local refill_per_ms = capacity / 60000
local time = redis.call('TIME')
local now_ms = time[1] * 1000 + math.floor(time[2] / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'stamp_ms')
local tokens = tonumber(state[1])
local stamp_ms = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  stamp_ms = now_ms
end
tokens = math.min(capacity, tokens + (now_ms - stamp_ms) * refill_per_ms)

local allowed = 0
local retry_after_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after_ms = math.ceil((1 - tokens) / refill_per_ms)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'stamp_ms', now_ms)
-- The bucket is full again after at most a minute of inactivity, at which
-- point the key carries no information; let it expire.
redis.call('PEXPIRE', KEYS[1], 60000)
return {allowed, retry_after_ms}
`;

/**
 * Succeeds when the caller may proceed and fails with RateLimited when it
 * may not, so "allowed" is not a boolean anyone can forget to check.
 *
 * Redis being unreachable is not one of the outcomes here. That is a fault,
 * not a verdict on the request, so it stays unhandled and surfaces as a 500
 * with the original error in the logs rather than as a quiet rejection.
 */
export function takeRateLimitToken(
  userId: string,
  perMinute: number,
): Effect.Effect<void, RateLimited, RedisService> {
  return Effect.gen(function* () {
    const redis = yield* RedisService;

    const [allowed, retryAfterMs] = yield* Effect.promise(
      () => redis.eval(TAKE_TOKEN, 1, `rate:${userId}`, perMinute) as Promise<[number, number]>,
    );

    if (allowed !== 1) {
      yield* Effect.fail(
        new RateLimited({ retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }),
      );
    }
  });
}

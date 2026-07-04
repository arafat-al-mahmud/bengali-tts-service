import type { Redis } from './redis.js';

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

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until a token is available; 0 when allowed. */
  retryAfterSeconds: number;
}

export async function takeRateLimitToken(
  redis: Redis,
  userId: string,
  perMinute: number,
): Promise<RateLimitDecision> {
  const [allowed, retryAfterMs] = (await redis.eval(TAKE_TOKEN, 1, `rate:${userId}`, perMinute)) as [
    number,
    number,
  ];
  return {
    allowed: allowed === 1,
    retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

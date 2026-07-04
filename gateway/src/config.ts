import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1).default('tts-audio'),
  LOG_LEVEL: z.string().default('info'),
  TTS_QUEUE_NAME: z.string().min(1).default('tts'),
  TTS_MAX_TEXT_LENGTH: z.coerce.number().int().positive().default(1000),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  // How often an SSE stream re-reads its job row while waiting for a change.
  SSE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  // Backpressure gates on job submission, checked in this order.
  TTS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  TTS_PENDING_CAP: z.coerce.number().int().positive().default(10),
  TTS_QUEUE_CAPACITY: z.coerce.number().int().positive().default(100),
  // Total delivery attempts per job (2 = one retry) and the base backoff.
  TTS_JOB_ATTEMPTS: z.coerce.number().int().positive().default(2),
  TTS_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(5000),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration, check environment variables: ${missing}`);
  }
  return parsed.data;
}

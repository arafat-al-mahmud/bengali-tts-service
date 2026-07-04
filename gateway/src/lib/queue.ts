import { Queue } from 'bullmq';
import type { Redis } from './redis.js';

export interface TtsJobPayload {
  jobId: string;
  /** Request id of the submission; ties worker logs to gateway logs. */
  correlationId?: string;
}

export type TtsQueue = Queue<TtsJobPayload>;

export function createTtsQueue(redis: Redis, queueName: string): TtsQueue {
  return new Queue(queueName, { connection: redis });
}

/** Jobs waiting, delayed, or running: the backlog a new submission joins. */
export async function queueDepth(queue: TtsQueue): Promise<number> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
  return Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
}

export interface RetryPolicy {
  attempts: number;
  backoffMs: number;
}

export async function enqueueTtsJob(
  queue: TtsQueue,
  jobId: string,
  retry: RetryPolicy,
  correlationId?: string,
): Promise<void> {
  // The database id doubles as the BullMQ job id, so a duplicate enqueue
  // for the same job is a no-op instead of a second synthesis.
  await queue.add(
    'synthesize',
    { jobId, ...(correlationId !== undefined && { correlationId }) },
    {
      jobId,
      attempts: retry.attempts,
      backoff: { type: 'exponential', delay: retry.backoffMs },
    },
  );
}

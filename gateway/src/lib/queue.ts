import { Queue } from 'bullmq';
import type { Redis } from './redis.js';

export interface TtsJobPayload {
  jobId: string;
}

export type TtsQueue = Queue<TtsJobPayload>;

export function createTtsQueue(redis: Redis, queueName: string): TtsQueue {
  return new Queue(queueName, { connection: redis });
}

export async function enqueueTtsJob(queue: TtsQueue, jobId: string): Promise<void> {
  // The database id doubles as the BullMQ job id, so a duplicate enqueue
  // for the same job is a no-op instead of a second synthesis.
  await queue.add('synthesize', { jobId }, { jobId });
}

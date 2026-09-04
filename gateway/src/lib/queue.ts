import { Queue } from 'bullmq';
import { Context, Data, Effect, Schedule } from 'effect';
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

/** The name Effect code uses to ask for the job queue. */
export class QueueService extends Context.Tag('QueueService')<QueueService, TtsQueue>() {}

/**
 * The queue did not answer. Like storage, this is not one of the refusals
 * in errors.ts: the client did nothing wrong, so it renders as a 500.
 */
export class QueueUnavailable extends Data.TaggedError('QueueUnavailable')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/**
 * Reading the depth is repeatable, so a dropped connection is worth one
 * more try. Unlike object storage there is nothing to discriminate on: a
 * queue read either answers or the connection failed, so the policy is
 * simply bounded rather than conditional.
 */
const DEPTH_READ_RETRY = Schedule.exponential('50 millis').pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(2)),
);

/** Jobs waiting, delayed, or running: the backlog a new submission joins. */
export function queueDepth(): Effect.Effect<number, QueueUnavailable, QueueService> {
  return Effect.gen(function* () {
    const queue = yield* QueueService;
    const counts = yield* Effect.tryPromise({
      try: () => queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized'),
      catch: (cause) => new QueueUnavailable({ operation: 'getJobCounts', cause }),
    });
    return Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  }).pipe(Effect.retry(DEPTH_READ_RETRY));
}

export interface RetryPolicy {
  attempts: number;
  backoffMs: number;
}

/**
 * Hands a job to the workers. `attempts` and `backoff` are the workers'
 * own retry policy, carried on the job and applied by BullMQ during
 * synthesis; nothing here re-runs them.
 *
 * Deliberately not retried. The database id doubles as the BullMQ job id,
 * so a second enqueue for the same job is a no-op rather than a second
 * synthesis — a retry would be safe, but the caller already answers a
 * failed enqueue by removing the orphaned row, and hiding the failure here
 * would take that decision away from it.
 */
export function enqueueTtsJob(
  jobId: string,
  retry: RetryPolicy,
  correlationId?: string,
): Effect.Effect<void, QueueUnavailable, QueueService> {
  return Effect.gen(function* () {
    const queue = yield* QueueService;
    yield* Effect.tryPromise({
      try: () =>
        queue.add(
          'synthesize',
          { jobId, ...(correlationId !== undefined && { correlationId }) },
          {
            jobId,
            attempts: retry.attempts,
            backoff: { type: 'exponential', delay: retry.backoffMs },
          },
        ),
      catch: (cause) => new QueueUnavailable({ operation: 'add', cause }),
    });
  });
}

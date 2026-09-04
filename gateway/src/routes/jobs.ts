import { Effect } from 'effect';
import { Router, type Request } from 'express';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import {
  IdempotencyConflict,
  JobFailed,
  JobNotReady,
  NotFound,
  PendingCapExceeded,
  QueueFull,
  ValidationFailed,
} from '../lib/errors.js';
import { enqueueTtsJob, QueueService, queueDepth } from '../lib/queue.js';
import { takeRateLimitToken } from '../lib/rate-limit.js';
import { RedisService } from '../lib/redis.js';
import { attempt, attemptPromise, runEffect } from '../lib/run-effect.js';
import { getAudioObject, StorageService } from '../lib/storage.js';
import { validateTtsText } from '../lib/tts-text.js';
import { requireParam, validate } from '../lib/validate.js';
import { apiKeyAuth, requireUser, type AuthedUser } from '../middleware/auth.js';
import { Prisma, type Job } from '../generated/prisma/client.js';

const submitSchema = z.object({
  text: z.string(),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});

function serializeJob(job: Job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    ...(job.status === 'COMPLETED' && { audioUrl: `/v1/jobs/${job.id}/audio` }),
    ...(job.status === 'FAILED' && {
      error: { code: job.errorCode ?? 'INTERNAL', message: job.errorMessage ?? 'Job failed' },
    }),
  };
}

function readIdempotencyKey(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 255) {
    throw new ValidationFailed({ message: 'Idempotency-Key must be 1-255 characters' });
  }
  return raw;
}

export function jobsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = apiKeyAuth(deps.prisma);

  /** The scoped lookup every job route shares: another user's job id is
   * indistinguishable from a nonexistent one. */
  async function findOwnedJob(req: Request): Promise<Job> {
    const user = requireUser(req);
    const job = await deps.prisma.job.findFirst({
      where: { id: requireParam(req, 'id'), userId: user.id },
    });
    if (!job) throw new NotFound();
    return job;
  }

  function submissionBody(job: Job) {
    return {
      jobId: job.id,
      status: job.status,
      statusUrl: `/v1/jobs/${job.id}`,
      pollIntervalMs: deps.config.POLL_INTERVAL_MS,
    };
  }

  /** What the client is owed: a replay of a stored job, or a new one. */
  type Submission = { readonly status: 200 | 202; readonly job: Job };

  // A retry with the original text replays the stored job; the same key
  // with different input text is a client bug, called out as a conflict.
  function replayOf(job: Job, body: unknown): Effect.Effect<Submission, unknown> {
    return Effect.gen(function* () {
      const { text } = yield* attempt(() => validate(submitSchema, body));
      if (text !== job.inputText) return yield* Effect.fail(new IdempotencyConflict());
      return { status: 200, job } as const;
    });
  }

  /**
   * The capacity gates and the insert as one unit, or the winner's row
   * when a same-key submission beat us to it.
   *
   * The pending count and the insert must act as one unit, or a burst of
   * concurrent submissions all reads the same count and lands the whole
   * burst over the cap. A per-user advisory lock serializes only this
   * user's submissions; everyone else proceeds in parallel.
   */
  async function insertUnderCapacity(
    user: AuthedUser,
    text: string,
    idempotencyKey: string | undefined,
  ): Promise<{ readonly created: Job } | { readonly lostRace: Job }> {
    try {
      const job = await deps.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;

        const pending = await tx.job.count({
          where: { userId: user.id, status: { in: ['QUEUED', 'ACTIVE'] } },
        });
        if (pending >= deps.config.TTS_PENDING_CAP) {
          deps.metrics.gateRejections.inc({ gate: 'pending_cap' });
          throw new PendingCapExceeded();
        }

        // Unlike the per-user cap above, this global check is check-then-act:
        // submissions from different users hold different advisory locks, so
        // two of them can read the same depth and both land. Exact enforcement
        // would take a global lock serializing every submission. The overshoot
        // is bounded by the connection pool (only that many transactions sit
        // between this read and their insert at once), and the gate is load
        // shedding, not a contract, so approximate is the right trade.
        const depth = await runEffect(
          deps.runtime,
          queueDepth().pipe(Effect.provideService(QueueService, deps.queue)),
        );
        if (depth >= deps.config.TTS_QUEUE_CAPACITY) {
          deps.metrics.gateRejections.inc({ gate: 'queue_full' });
          throw new QueueFull();
        }

        return tx.job.create({
          data: {
            userId: user.id,
            inputText: text,
            ...(idempotencyKey !== undefined && { idempotencyKey }),
          },
        });
      });
      return { created: job };
    } catch (err) {
      // Two same-key submissions racing past the replay check: the unique
      // constraint lets exactly one insert win; the loser is answered from
      // the winner's row (replay or conflict).
      if (
        idempotencyKey !== undefined &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await deps.prisma.job.findFirst({
          where: { userId: user.id, idempotencyKey },
        });
        if (winner) return { lostRace: winner };
      }
      throw err;
    }
  }

  async function enqueueOrRemoveJob(job: Job, correlationId: string | undefined): Promise<void> {
    try {
      await runEffect(
        deps.runtime,
        enqueueTtsJob(
          job.id,
          {
            attempts: deps.config.TTS_JOB_ATTEMPTS,
            backoffMs: deps.config.TTS_RETRY_BACKOFF_MS,
          },
          correlationId,
        ).pipe(Effect.provideService(QueueService, deps.queue)),
      );
    } catch (err) {
      // A job row without a queue entry would wait forever; better to fail
      // the submission outright and let the client retry.
      await deps.prisma.job.delete({ where: { id: job.id } }).catch(() => undefined);
      throw err;
    }
  }

  router.post('/v1/tts', auth, async (req, res) => {
    const user = requireUser(req);
    const idempotencyKey = readIdempotencyKey(req);
    const correlationId = typeof req.id === 'string' ? req.id : undefined;

    // The whole submission is one Effect so its stages are one trace
    // rather than five unrelated ones: the parent span below is what a
    // waterfall hangs from, and each stage names itself inside it. Until
    // now the only observable number for a submission was its total
    // duration, which cannot tell a slow gate from a slow insert.
    const submission = await runEffect(
      deps.runtime,
      Effect.gen(function* () {
        // Replay before the gates: a client retrying a submission it never
        // got an answer for must find its job even while the queue is full
        // or its bucket is empty. That safety is the whole point of the key.
        if (idempotencyKey !== undefined) {
          const existing = yield* attemptPromise(() =>
            deps.prisma.job.findFirst({ where: { userId: user.id, idempotencyKey } }),
          ).pipe(Effect.withSpan('tts.submit.idempotency_replay'));
          if (existing) return yield* replayOf(existing, req.body);
        }

        // Backpressure gates, in order, each with a distinct rejection so
        // clients know whether to slow down, wait for running jobs, or back
        // off entirely. All fire before any Job row or queue entry exists.
        // Counting the rejection is attached to the failure itself rather
        // than written in a branch beside it, so the gate cannot reject
        // without the metric moving. Redis arrives by name, supplied here.
        yield* takeRateLimitToken(user.id, deps.config.TTS_RATE_LIMIT_PER_MINUTE).pipe(
          Effect.tapError(() =>
            Effect.sync(() => deps.metrics.gateRejections.inc({ gate: 'rate_limit' })),
          ),
          Effect.provideService(RedisService, deps.redis),
          Effect.withSpan('tts.submit.rate_limit'),
        );

        const { text } = yield* attempt(() => validate(submitSchema, req.body));
        // The rules run as a value this pipeline executes rather than as a
        // function that throws from somewhere inside. What it can reject is
        // fixed by its type.
        yield* validateTtsText(text, deps.config.TTS_MAX_TEXT_LENGTH).pipe(
          Effect.withSpan('tts.submit.validate_text'),
        );

        const inserted = yield* attemptPromise(() =>
          insertUnderCapacity(user, text, idempotencyKey),
        ).pipe(Effect.withSpan('tts.submit.capacity_and_insert'));
        if ('lostRace' in inserted) return yield* replayOf(inserted.lostRace, req.body);

        yield* attemptPromise(() => enqueueOrRemoveJob(inserted.created, correlationId)).pipe(
          Effect.withSpan('tts.submit.enqueue'),
        );

        return { status: 202, job: inserted.created } as const;
      }).pipe(
        // The trace carries the same request id that pino stamps on every
        // log line for this request and that the worker logs against, so
        // one identifier walks between a response, its logs, and its
        // trace in either direction.
        Effect.withSpan('tts.submit', {
          attributes: { ...(correlationId !== undefined && { 'request.id': correlationId }) },
        }),
      ),
    );

    res.status(submission.status).json(submissionBody(submission.job));
  });

  router.get('/v1/jobs', auth, async (req, res) => {
    const user = requireUser(req);
    const { limit, cursor } = validate(historyQuerySchema, req.query);

    // Cursor pagination stays correct while new jobs arrive, unlike
    // offsets. Ordering matches the (user_id, created_at desc) index;
    // id breaks ties within a timestamp. A cursor that is not one of the
    // caller's own jobs positions nowhere and yields an empty page.
    const rows = await deps.prisma.job.findMany({
      where: { userId: user.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor !== undefined && { cursor: { id: cursor }, skip: 1 }),
    });

    const page = rows.slice(0, limit);
    res.json({
      jobs: page.map(serializeJob),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    });
  });

  router.get('/v1/jobs/:id', auth, async (req, res) => {
    const job = await findOwnedJob(req);
    res.json(serializeJob(job));
  });

  router.get('/v1/jobs/:id/events', auth, async (req, res) => {
    // The ownership check runs before any stream state, so its 404 is an
    // ordinary JSON response, identical for foreign and unknown ids.
    const job = await findOwnedJob(req);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const isTerminal = (status: Job['status']) => status === 'COMPLETED' || status === 'FAILED';
    const send = (row: Job) => {
      res.write(`event: status\ndata: ${JSON.stringify(serializeJob(row))}\n\n`);
    };

    // Snapshot first, then watch: the subscriber always sees the current
    // status immediately, and a transition can never slip between the
    // snapshot and the first poll.
    send(job);
    if (isTerminal(job.status)) {
      res.end();
      return;
    }

    // Watching is a per-connection database poll. The worker's only write
    // channel is the jobs table, so polling it needs no extra moving parts
    // and inherits its correctness; at higher connection counts the poll
    // would be replaced by a Redis subscription feeding the same snapshot-
    // then-watch loop.
    let lastStatus: Job['status'] = job.status;
    deps.sse.add(res);
    const timer = setInterval(() => {
      void (async () => {
        const row = await deps.prisma.job.findUnique({ where: { id: job.id } });
        if (!row) {
          stop();
          res.end();
          return;
        }
        if (row.status !== lastStatus) {
          lastStatus = row.status;
          send(row);
        }
        if (isTerminal(row.status)) {
          stop();
          res.end();
        }
      })().catch(() => {
        // The stream is best effort once headers are out; on a poll error
        // the client sees end-of-stream and reconnects or falls back to
        // polling GET /v1/jobs/:id.
        stop();
        res.end();
      });
    }, deps.config.SSE_POLL_INTERVAL_MS);
    const stop = () => {
      clearInterval(timer);
      deps.sse.remove(res);
    };
    res.on('close', stop);
  });

  router.get('/v1/jobs/:id/audio', auth, async (req, res) => {
    const job = await findOwnedJob(req);
    if (job.status === 'FAILED') {
      throw new JobFailed();
    }
    if (job.status !== 'COMPLETED' || !job.audioKey) {
      throw new JobNotReady();
    }

    // Fetching a finished recording is a repeatable read, so a connection
    // that dropped on the way out is retried rather than handed to the
    // client as a 500. A missing object is an answer, not a blip, and
    // surfaces on the first try.
    const object = await runEffect(
      deps.runtime,
      getAudioObject(deps.config.S3_BUCKET, job.audioKey).pipe(
        Effect.provideService(StorageService, deps.s3),
      ),
    );
    res.setHeader('Content-Type', 'audio/wav');
    if (object.ContentLength !== undefined) {
      res.setHeader('Content-Length', object.ContentLength.toString());
    }
    (object.Body as Readable).pipe(res);
  });

  return router;
}

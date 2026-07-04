import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Router, type Request, type Response } from 'express';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { ApiError } from '../lib/errors.js';
import { enqueueTtsJob, queueDepth } from '../lib/queue.js';
import { takeRateLimitToken } from '../lib/rate-limit.js';
import { validateTtsText } from '../lib/tts-text.js';
import { requireParam, validate } from '../lib/validate.js';
import { apiKeyAuth, requireUser } from '../middleware/auth.js';
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
    throw new ApiError(422, 'VALIDATION_ERROR', 'Idempotency-Key must be 1-255 characters');
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
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
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

  // A retry with the original text replays the stored job; the same key
  // with different input text is a client bug, called out as a conflict.
  function respondForIdempotentRetry(res: Response, job: Job, body: unknown): void {
    const { text } = validate(submitSchema, body);
    if (text !== job.inputText) {
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used with different input text',
      );
    }
    res.status(200).json(submissionBody(job));
  }

  router.post('/v1/tts', auth, async (req, res) => {
    const user = requireUser(req);
    const idempotencyKey = readIdempotencyKey(req);

    // Replay before the gates: a client retrying a submission it never got
    // an answer for must find its job even while the queue is full or its
    // bucket is empty. That safety is the whole point of the key.
    if (idempotencyKey !== undefined) {
      const existing = await deps.prisma.job.findFirst({
        where: { userId: user.id, idempotencyKey },
      });
      if (existing) {
        respondForIdempotentRetry(res, existing, req.body);
        return;
      }
    }

    // Backpressure gates, in order, each with a distinct rejection so
    // clients know whether to slow down, wait for running jobs, or back
    // off entirely. All fire before any Job row or queue entry exists.
    const rate = await takeRateLimitToken(
      deps.redis,
      user.id,
      deps.config.TTS_RATE_LIMIT_PER_MINUTE,
    );
    if (!rate.allowed) {
      deps.metrics.gateRejections.inc({ gate: 'rate_limit' });
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      throw new ApiError(429, 'RATE_LIMITED', 'Request rate limit exceeded; retry later');
    }

    const { text } = validate(submitSchema, req.body);
    validateTtsText(text, deps.config.TTS_MAX_TEXT_LENGTH);

    // The pending count and the insert must act as one unit, or a burst of
    // concurrent submissions all reads the same count and lands the whole
    // burst over the cap. A per-user advisory lock serializes only this
    // user's submissions; everyone else proceeds in parallel.
    let job: Job;
    try {
      job = await deps.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;

        const pending = await tx.job.count({
          where: { userId: user.id, status: { in: ['QUEUED', 'ACTIVE'] } },
        });
        if (pending >= deps.config.TTS_PENDING_CAP) {
          deps.metrics.gateRejections.inc({ gate: 'pending_cap' });
          throw new ApiError(
            429,
            'PENDING_CAP_EXCEEDED',
            'Too many unfinished jobs; wait for them to complete instead of retrying',
          );
        }

        // Unlike the per-user cap above, this global check is check-then-act:
        // submissions from different users hold different advisory locks, so
        // two of them can read the same depth and both land. Exact enforcement
        // would take a global lock serializing every submission. The overshoot
        // is bounded by the connection pool (only that many transactions sit
        // between this read and their insert at once), and the gate is load
        // shedding, not a contract, so approximate is the right trade.
        const depth = await queueDepth(deps.queue);
        if (depth >= deps.config.TTS_QUEUE_CAPACITY) {
          deps.metrics.gateRejections.inc({ gate: 'queue_full' });
          throw new ApiError(503, 'QUEUE_FULL', 'Service is at capacity; retry later');
        }

        return tx.job.create({
          data: {
            userId: user.id,
            inputText: text,
            ...(idempotencyKey !== undefined && { idempotencyKey }),
          },
        });
      });
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
        if (winner) {
          respondForIdempotentRetry(res, winner, req.body);
          return;
        }
      }
      throw err;
    }
    try {
      await enqueueTtsJob(
        deps.queue,
        job.id,
        {
          attempts: deps.config.TTS_JOB_ATTEMPTS,
          backoffMs: deps.config.TTS_RETRY_BACKOFF_MS,
        },
        typeof req.id === 'string' ? req.id : undefined,
      );
    } catch (err) {
      // A job row without a queue entry would wait forever; better to fail
      // the submission outright and let the client retry.
      await deps.prisma.job.delete({ where: { id: job.id } }).catch(() => undefined);
      throw err;
    }

    res.status(202).json(submissionBody(job));
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
      throw new ApiError(409, 'JOB_FAILED', 'Job failed; no audio was produced');
    }
    if (job.status !== 'COMPLETED' || !job.audioKey) {
      throw new ApiError(409, 'JOB_NOT_READY', 'Job has not completed yet; keep polling');
    }

    const object = await deps.s3.send(
      new GetObjectCommand({ Bucket: deps.config.S3_BUCKET, Key: job.audioKey }),
    );
    res.setHeader('Content-Type', 'audio/wav');
    if (object.ContentLength !== undefined) {
      res.setHeader('Content-Length', object.ContentLength.toString());
    }
    (object.Body as Readable).pipe(res);
  });

  return router;
}

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Router } from 'express';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { ApiError } from '../lib/errors.js';
import { enqueueTtsJob } from '../lib/queue.js';
import { takeRateLimitToken } from '../lib/rate-limit.js';
import { validateTtsText } from '../lib/tts-text.js';
import { requireParam, validate } from '../lib/validate.js';
import { apiKeyAuth, requireUser } from '../middleware/auth.js';
import type { Job } from '../generated/prisma/client.js';

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

export function jobsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = apiKeyAuth(deps.prisma);

  router.post('/v1/tts', auth, async (req, res) => {
    const user = requireUser(req);

    // Backpressure gates, in order, each with a distinct rejection so
    // clients know whether to slow down, wait for running jobs, or back
    // off entirely. All fire before any Job row or queue entry exists.
    const rate = await takeRateLimitToken(
      deps.redis,
      user.id,
      deps.config.TTS_RATE_LIMIT_PER_MINUTE,
    );
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      throw new ApiError(429, 'RATE_LIMITED', 'Request rate limit exceeded; retry later');
    }

    const { text } = validate(submitSchema, req.body);
    validateTtsText(text, deps.config.TTS_MAX_TEXT_LENGTH);

    // The pending count and the insert must act as one unit, or a burst of
    // concurrent submissions all reads the same count and lands the whole
    // burst over the cap. A per-user advisory lock serializes only this
    // user's submissions; everyone else proceeds in parallel.
    const job = await deps.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;

      const pending = await tx.job.count({
        where: { userId: user.id, status: { in: ['QUEUED', 'ACTIVE'] } },
      });
      if (pending >= deps.config.TTS_PENDING_CAP) {
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
      const counts = await deps.queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
      const depth = Object.values(counts).reduce((sum, n) => sum + n, 0);
      if (depth >= deps.config.TTS_QUEUE_CAPACITY) {
        throw new ApiError(503, 'QUEUE_FULL', 'Service is at capacity; retry later');
      }

      return tx.job.create({
        data: { userId: user.id, inputText: text },
      });
    });
    try {
      await enqueueTtsJob(deps.queue, job.id);
    } catch (err) {
      // A job row without a queue entry would wait forever; better to fail
      // the submission outright and let the client retry.
      await deps.prisma.job.delete({ where: { id: job.id } }).catch(() => undefined);
      throw err;
    }

    res.status(202).json({
      jobId: job.id,
      status: job.status,
      statusUrl: `/v1/jobs/${job.id}`,
      pollIntervalMs: deps.config.POLL_INTERVAL_MS,
    });
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
    const user = requireUser(req);
    // Scoping the lookup to the caller makes another user's job id
    // indistinguishable from a nonexistent one.
    const job = await deps.prisma.job.findFirst({
      where: { id: requireParam(req, 'id'), userId: user.id },
    });
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
    res.json(serializeJob(job));
  });

  router.get('/v1/jobs/:id/audio', auth, async (req, res) => {
    const user = requireUser(req);
    const job = await deps.prisma.job.findFirst({
      where: { id: requireParam(req, 'id'), userId: user.id },
    });
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
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

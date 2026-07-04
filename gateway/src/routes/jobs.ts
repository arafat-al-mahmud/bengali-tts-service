import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Router } from 'express';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { ApiError } from '../lib/errors.js';
import { enqueueTtsJob } from '../lib/queue.js';
import { validateTtsText } from '../lib/tts-text.js';
import { requireParam, validate } from '../lib/validate.js';
import { apiKeyAuth, requireUser } from '../middleware/auth.js';
import type { Job } from '../generated/prisma/client.js';

const submitSchema = z.object({
  text: z.string(),
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
    const { text } = validate(submitSchema, req.body);
    validateTtsText(text, deps.config.TTS_MAX_TEXT_LENGTH);

    const job = await deps.prisma.job.create({
      data: { userId: user.id, inputText: text },
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

import { PutObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/test-app.js';

const BENGALI = 'আজকের আবহাওয়া খুব সুন্দর এবং আকাশ পরিষ্কার।';

let ctx: TestContext;
let seq = 0;

async function createUserWithKey(): Promise<{ bearer: string; userId: string }> {
  seq += 1;
  const email = `jobs-${Date.now()}-${seq}@example.com`;
  const password = 'a sufficiently long password';
  const registered = await request(ctx.app).post('/v1/auth/register').send({ email, password });
  const basic = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
  const created = await request(ctx.app).post('/v1/keys').set('Authorization', basic);
  return {
    bearer: `Bearer ${(created.body as { key: string }).key}`,
    userId: (registered.body as { id: string }).id,
  };
}

/**
 * Plays the worker's part directly against real MinIO and Postgres. The
 * genuine consume path (BullMQ to fake engine to upload) is covered by the
 * worker's own integration suite.
 */
async function completeJobLikeWorker(jobId: string, userId: string): Promise<Buffer> {
  const wav = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WAVEfmt '),
    Buffer.alloc(1000),
  ]);
  const audioKey = `audio/${userId}/${jobId}.wav`;
  await ctx.deps.s3.send(
    new PutObjectCommand({
      Bucket: ctx.deps.config.S3_BUCKET,
      Key: audioKey,
      Body: wav,
      ContentType: 'audio/wav',
    }),
  );
  await ctx.deps.prisma.job.update({
    where: { id: jobId },
    data: { status: 'COMPLETED', audioKey, startedAt: new Date(), completedAt: new Date() },
  });
  return wav;
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

describe('POST /v1/tts', () => {
  it('accepts Bengali text with 202, creates a QUEUED job, and enqueues it', async () => {
    const user = await createUserWithKey();
    const res = await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', user.bearer)
      .send({ text: BENGALI });

    expect(res.status).toBe(202);
    const body = res.body as { jobId: string; status: string; statusUrl: string; pollIntervalMs: number };
    expect(body.status).toBe('QUEUED');
    expect(body.statusUrl).toBe(`/v1/jobs/${body.jobId}`);
    expect(body.pollIntervalMs).toBeGreaterThan(0);

    const row = await ctx.deps.prisma.job.findUnique({ where: { id: body.jobId } });
    expect(row).toMatchObject({ status: 'QUEUED', userId: user.userId, inputText: BENGALI });

    const queued = await ctx.deps.queue.getJob(body.jobId);
    expect(queued?.data).toEqual({ jobId: body.jobId });
  });

  it('requires an API key', async () => {
    const res = await request(ctx.app).post('/v1/tts').send({ text: BENGALI });
    expect(res.status).toBe(401);
  });

  it.each([
    ['empty text', '', 'TEXT_EMPTY'],
    ['whitespace-only text', '   \n ', 'TEXT_EMPTY'],
    ['oversized text', 'আ'.repeat(1001), 'TEXT_TOO_LONG'],
    ['non-Bengali text', 'this text is entirely in english', 'TEXT_NOT_BENGALI'],
  ])('rejects %s with 422 %s', async (_label, text, code) => {
    const user = await createUserWithKey();
    const res = await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', user.bearer)
      .send({ text });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code } });
  });

  it('does not create a job row for rejected input', async () => {
    const user = await createUserWithKey();
    await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', user.bearer)
      .send({ text: 'english only' });
    const count = await ctx.deps.prisma.job.count({ where: { userId: user.userId } });
    expect(count).toBe(0);
  });
});

describe('GET /v1/jobs/:id', () => {
  it('shows the owner a QUEUED job', async () => {
    const user = await createUserWithKey();
    const submitted = await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', user.bearer)
      .send({ text: BENGALI });
    const jobId = (submitted.body as { jobId: string }).jobId;

    const res = await request(ctx.app).get(`/v1/jobs/${jobId}`).set('Authorization', user.bearer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: jobId, status: 'QUEUED' });
    expect(res.body).not.toHaveProperty('audioUrl');
  });

  it("returns 404 for another user's job and for an unknown id", async () => {
    const owner = await createUserWithKey();
    const other = await createUserWithKey();
    const submitted = await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', owner.bearer)
      .send({ text: BENGALI });
    const jobId = (submitted.body as { jobId: string }).jobId;

    const crossUser = await request(ctx.app)
      .get(`/v1/jobs/${jobId}`)
      .set('Authorization', other.bearer);
    const unknown = await request(ctx.app)
      .get('/v1/jobs/00000000-0000-0000-0000-000000000000')
      .set('Authorization', other.bearer);

    expect(crossUser.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(crossUser.body).toEqual(unknown.body);
  });

  it('includes the audio URL once completed', async () => {
    const user = await createUserWithKey();
    const submitted = await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', user.bearer)
      .send({ text: BENGALI });
    const jobId = (submitted.body as { jobId: string }).jobId;
    await completeJobLikeWorker(jobId, user.userId);

    const res = await request(ctx.app).get(`/v1/jobs/${jobId}`).set('Authorization', user.bearer);
    expect(res.body).toMatchObject({ status: 'COMPLETED', audioUrl: `/v1/jobs/${jobId}/audio` });
  });
});

describe('GET /v1/jobs/:id/audio', () => {
  it('returns 409 JOB_NOT_READY before completion', async () => {
    const user = await createUserWithKey();
    const submitted = await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', user.bearer)
      .send({ text: BENGALI });
    const jobId = (submitted.body as { jobId: string }).jobId;

    const res = await request(ctx.app)
      .get(`/v1/jobs/${jobId}/audio`)
      .set('Authorization', user.bearer);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'JOB_NOT_READY' } });
  });

  it('streams the WAV to the owner and 404s for anyone else', async () => {
    const owner = await createUserWithKey();
    const other = await createUserWithKey();
    const submitted = await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', owner.bearer)
      .send({ text: BENGALI });
    const jobId = (submitted.body as { jobId: string }).jobId;
    const wav = await completeJobLikeWorker(jobId, owner.userId);

    const res = await request(ctx.app)
      .get(`/v1/jobs/${jobId}/audio`)
      .set('Authorization', owner.bearer)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/wav');
    expect(Buffer.compare(res.body as Buffer, wav)).toBe(0);

    const crossUser = await request(ctx.app)
      .get(`/v1/jobs/${jobId}/audio`)
      .set('Authorization', other.bearer);
    expect(crossUser.status).toBe(404);
  });
});

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/test-app.js';

const BENGALI = 'আজকের আবহাওয়া খুব সুন্দর এবং আকাশ পরিষ্কার।';
const OTHER_BENGALI = 'আগামীকাল সকালে আমাদের দলের সাপ্তাহিক সভা অনুষ্ঠিত হবে।';

let ctx: TestContext;
let seq = 0;

async function createUserWithKey(): Promise<{ bearer: string; userId: string }> {
  seq += 1;
  const email = `idem-${Date.now()}-${seq}@example.com`;
  const password = 'a sufficiently long password';
  const registered = await request(ctx.app).post('/v1/auth/register').send({ email, password });
  const basic = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
  const created = await request(ctx.app).post('/v1/keys').set('Authorization', basic);
  return {
    bearer: `Bearer ${(created.body as { key: string }).key}`,
    userId: (registered.body as { id: string }).id,
  };
}

function submit(bearer: string, text: string, idempotencyKey?: string) {
  const req = request(ctx.app).post('/v1/tts').set('Authorization', bearer);
  if (idempotencyKey !== undefined) req.set('Idempotency-Key', idempotencyKey);
  return req.send({ text });
}

beforeAll(async () => {
  ctx = await createTestContext({ TTS_QUEUE_NAME: 'tts-idempotency' });
});

afterAll(async () => {
  await ctx.close();
});

describe('Idempotency-Key on POST /v1/tts', () => {
  it('replays the original job for the same user, key, and payload', async () => {
    const user = await createUserWithKey();

    const first = await submit(user.bearer, BENGALI, 'retry-abc');
    expect(first.status).toBe(202);
    const jobId = (first.body as { jobId: string }).jobId;

    const replay = await submit(user.bearer, BENGALI, 'retry-abc');
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ jobId, statusUrl: `/v1/jobs/${jobId}` });

    const rows = await ctx.deps.prisma.job.count({ where: { userId: user.userId } });
    expect(rows).toBe(1);
    const counts = await ctx.deps.queue.getJobCounts('waiting');
    expect(counts.waiting).toBe(1);
  });

  it('rejects the same key with a different payload as a conflict', async () => {
    const user = await createUserWithKey();

    await submit(user.bearer, BENGALI, 'conflict-key');
    const conflicting = await submit(user.bearer, OTHER_BENGALI, 'conflict-key');

    expect(conflicting.status).toBe(409);
    expect(conflicting.body).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    const rows = await ctx.deps.prisma.job.count({ where: { userId: user.userId } });
    expect(rows).toBe(1);
  });

  it('scopes keys per user: two users can use the same key value', async () => {
    const alice = await createUserWithKey();
    const bob = await createUserWithKey();

    const fromAlice = await submit(alice.bearer, BENGALI, 'shared-key');
    const fromBob = await submit(bob.bearer, BENGALI, 'shared-key');

    expect(fromAlice.status).toBe(202);
    expect(fromBob.status).toBe(202);
    expect((fromAlice.body as { jobId: string }).jobId).not.toBe(
      (fromBob.body as { jobId: string }).jobId,
    );
  });

  it('still creates separate jobs when no key is supplied', async () => {
    const user = await createUserWithKey();

    const first = await submit(user.bearer, BENGALI);
    const second = await submit(user.bearer, BENGALI);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const rows = await ctx.deps.prisma.job.count({ where: { userId: user.userId } });
    expect(rows).toBe(2);
  });

  it('replays with the current status after the job has moved on', async () => {
    const user = await createUserWithKey();
    const first = await submit(user.bearer, BENGALI, 'late-replay');
    const jobId = (first.body as { jobId: string }).jobId;
    await ctx.deps.prisma.job.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    const replay = await submit(user.bearer, BENGALI, 'late-replay');
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ jobId, status: 'COMPLETED' });
  });

  it('rejects an unusable key with a validation error', async () => {
    const user = await createUserWithKey();
    const res = await submit(user.bearer, BENGALI, 'x'.repeat(256));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('enforces uniqueness in the database, not just in the application', async () => {
    const user = await createUserWithKey();
    await ctx.deps.prisma.job.create({
      data: { userId: user.userId, inputText: BENGALI, idempotencyKey: 'db-level' },
    });
    await expect(
      ctx.deps.prisma.job.create({
        data: { userId: user.userId, inputText: BENGALI, idempotencyKey: 'db-level' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

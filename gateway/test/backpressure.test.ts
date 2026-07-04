import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/test-app.js';

const BENGALI = 'আজকের আবহাওয়া খুব সুন্দর এবং আকাশ পরিষ্কার।';

let seq = 0;

async function createUserWithKey(ctx: TestContext): Promise<{ bearer: string; userId: string }> {
  seq += 1;
  const email = `bp-${Date.now()}-${seq}@example.com`;
  const password = 'a sufficiently long password';
  const registered = await request(ctx.app).post('/v1/auth/register').send({ email, password });
  const basic = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
  const created = await request(ctx.app).post('/v1/keys').set('Authorization', basic);
  return {
    bearer: `Bearer ${(created.body as { key: string }).key}`,
    userId: (registered.body as { id: string }).id,
  };
}

function submit(ctx: TestContext, bearer: string) {
  return request(ctx.app).post('/v1/tts').set('Authorization', bearer).send({ text: BENGALI });
}

describe('rate limit gate', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({
      TTS_QUEUE_NAME: 'tts-bp-rate',
      TTS_RATE_LIMIT_PER_MINUTE: '2',
      TTS_PENDING_CAP: '100',
      TTS_QUEUE_CAPACITY: '100',
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('returns 429 RATE_LIMITED with Retry-After once the bucket is empty', async () => {
    const user = await createUserWithKey(ctx);

    for (let i = 0; i < 2; i += 1) {
      const accepted = await submit(ctx, user.bearer);
      expect(accepted.status).toBe(202);
    }

    const rejected = await submit(ctx, user.bearer);
    expect(rejected.status).toBe(429);
    expect(rejected.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });

    // 2 tokens per minute means a fresh token arrives within 30 seconds.
    const retryAfter = Number(rejected.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
  });

  it('does not throttle one user because of another', async () => {
    const throttled = await createUserWithKey(ctx);
    const fresh = await createUserWithKey(ctx);

    await submit(ctx, throttled.bearer);
    await submit(ctx, throttled.bearer);
    const rejected = await submit(ctx, throttled.bearer);
    expect(rejected.status).toBe(429);

    const accepted = await submit(ctx, fresh.bearer);
    expect(accepted.status).toBe(202);
  });

  it('creates no job row or queue entry for a rate-limited request', async () => {
    const user = await createUserWithKey(ctx);
    await submit(ctx, user.bearer);
    await submit(ctx, user.bearer);
    const before = await ctx.deps.queue.getJobCounts('waiting');

    const rejected = await submit(ctx, user.bearer);
    expect(rejected.status).toBe(429);

    const rows = await ctx.deps.prisma.job.count({ where: { userId: user.userId } });
    expect(rows).toBe(2);
    const after = await ctx.deps.queue.getJobCounts('waiting');
    expect(after.waiting).toBe(before.waiting);
  });
});

describe('pending cap gate', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({
      TTS_QUEUE_NAME: 'tts-bp-pending',
      TTS_RATE_LIMIT_PER_MINUTE: '1000',
      TTS_PENDING_CAP: '2',
      TTS_QUEUE_CAPACITY: '100',
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('returns 429 PENDING_CAP_EXCEEDED and frees capacity when a job finishes', async () => {
    const user = await createUserWithKey(ctx);

    const first = await submit(ctx, user.bearer);
    const second = await submit(ctx, user.bearer);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const rejected = await submit(ctx, user.bearer);
    expect(rejected.status).toBe(429);
    expect(rejected.body).toMatchObject({ error: { code: 'PENDING_CAP_EXCEEDED' } });

    const rows = await ctx.deps.prisma.job.count({ where: { userId: user.userId } });
    expect(rows).toBe(2);

    // A finished job no longer counts against the cap.
    await ctx.deps.prisma.job.update({
      where: { id: (first.body as { jobId: string }).jobId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    const accepted = await submit(ctx, user.bearer);
    expect(accepted.status).toBe(202);
  });

  it('holds the cap under a concurrent burst', async () => {
    const user = await createUserWithKey(ctx);

    // Without atomicity every request reads pending=0 and the whole burst
    // lands; with it, exactly cap submissions get through.
    const burst = await Promise.all(
      Array.from({ length: 10 }, () => submit(ctx, user.bearer)),
    );

    const accepted = burst.filter((r) => r.status === 202);
    const rejected = burst.filter((r) => r.status === 429);
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(8);
    for (const r of rejected) {
      expect(r.body).toMatchObject({ error: { code: 'PENDING_CAP_EXCEEDED' } });
    }

    const rows = await ctx.deps.prisma.job.count({ where: { userId: user.userId } });
    expect(rows).toBe(2);
  });

  it('caps each user independently', async () => {
    const full = await createUserWithKey(ctx);
    const other = await createUserWithKey(ctx);

    await submit(ctx, full.bearer);
    await submit(ctx, full.bearer);
    const rejected = await submit(ctx, full.bearer);
    expect(rejected.status).toBe(429);

    const accepted = await submit(ctx, other.bearer);
    expect(accepted.status).toBe(202);
  });
});

describe('queue capacity gate', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({
      TTS_QUEUE_NAME: 'tts-bp-capacity',
      TTS_RATE_LIMIT_PER_MINUTE: '1000',
      TTS_PENDING_CAP: '100',
      TTS_QUEUE_CAPACITY: '2',
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('returns 503 QUEUE_FULL to every user once the queue is at capacity', async () => {
    const filler = await createUserWithKey(ctx);
    const other = await createUserWithKey(ctx);

    expect((await submit(ctx, filler.bearer)).status).toBe(202);
    expect((await submit(ctx, filler.bearer)).status).toBe(202);

    // The gate is global: a different user is rejected too.
    for (const user of [filler, other]) {
      const rejected = await submit(ctx, user.bearer);
      expect(rejected.status).toBe(503);
      expect(rejected.body).toMatchObject({ error: { code: 'QUEUE_FULL' } });
    }

    const otherRows = await ctx.deps.prisma.job.count({ where: { userId: other.userId } });
    expect(otherRows).toBe(0);
    const counts = await ctx.deps.queue.getJobCounts('waiting');
    expect(counts.waiting).toBe(2);
  });
});

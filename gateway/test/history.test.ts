import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/test-app.js';

const BENGALI = 'আজকের আবহাওয়া খুব সুন্দর এবং আকাশ পরিষ্কার।';

let ctx: TestContext;
let seq = 0;

async function createUserWithKey(): Promise<{ bearer: string; userId: string }> {
  seq += 1;
  const email = `history-${Date.now()}-${seq}@example.com`;
  const password = 'a sufficiently long password';
  const registered = await request(ctx.app).post('/v1/auth/register').send({ email, password });
  const basic = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
  const created = await request(ctx.app).post('/v1/keys').set('Authorization', basic);
  return {
    bearer: `Bearer ${(created.body as { key: string }).key}`,
    userId: (registered.body as { id: string }).id,
  };
}

async function submitJob(bearer: string): Promise<string> {
  const res = await request(ctx.app)
    .post('/v1/tts')
    .set('Authorization', bearer)
    .send({ text: BENGALI });
  return (res.body as { jobId: string }).jobId;
}

interface HistoryPage {
  jobs: Array<{ id: string; status: string; error?: { code: string } }>;
  nextCursor: string | null;
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

describe('GET /v1/jobs', () => {
  it('lists only the caller\'s jobs, newest first', async () => {
    const user = await createUserWithKey();
    const other = await createUserWithKey();
    const first = await submitJob(user.bearer);
    const second = await submitJob(user.bearer);
    await submitJob(other.bearer);

    const res = await request(ctx.app).get('/v1/jobs').set('Authorization', user.bearer);
    expect(res.status).toBe(200);
    const page = res.body as HistoryPage;
    expect(page.jobs.map((j) => j.id)).toEqual([second, first]);
    expect(page.nextCursor).toBeNull();
  });

  it('paginates with a stable page shape and cursor', async () => {
    const user = await createUserWithKey();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await submitJob(user.bearer));
    const newestFirst = [...ids].reverse();

    const pageOne = await request(ctx.app)
      .get('/v1/jobs?limit=2')
      .set('Authorization', user.bearer);
    const one = pageOne.body as HistoryPage;
    expect(one.jobs.map((j) => j.id)).toEqual(newestFirst.slice(0, 2));
    expect(one.nextCursor).toBe(newestFirst[1]);

    const pageTwo = await request(ctx.app)
      .get(`/v1/jobs?limit=2&cursor=${one.nextCursor}`)
      .set('Authorization', user.bearer);
    const two = pageTwo.body as HistoryPage;
    expect(two.jobs.map((j) => j.id)).toEqual(newestFirst.slice(2, 4));

    const pageThree = await request(ctx.app)
      .get(`/v1/jobs?limit=2&cursor=${two.nextCursor}`)
      .set('Authorization', user.bearer);
    const three = pageThree.body as HistoryPage;
    expect(three.jobs.map((j) => j.id)).toEqual(newestFirst.slice(4));
    expect(three.nextCursor).toBeNull();
  });

  it('rejects an invalid limit', async () => {
    const user = await createUserWithKey();
    const res = await request(ctx.app)
      .get('/v1/jobs?limit=0')
      .set('Authorization', user.bearer);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('shows failed jobs with their error codes', async () => {
    const user = await createUserWithKey();
    const jobId = await submitJob(user.bearer);
    await ctx.deps.prisma.job.update({
      where: { id: jobId },
      data: { status: 'FAILED', errorCode: 'TIMEOUT', errorMessage: 'Synthesis timed out' },
    });

    const res = await request(ctx.app).get('/v1/jobs').set('Authorization', user.bearer);
    const page = res.body as HistoryPage;
    expect(page.jobs[0]).toMatchObject({
      id: jobId,
      status: 'FAILED',
      error: { code: 'TIMEOUT' },
    });
  });

  it('treats another user\'s cursor like an empty page, not an error', async () => {
    const owner = await createUserWithKey();
    const attacker = await createUserWithKey();
    const jobId = await submitJob(owner.bearer);

    const res = await request(ctx.app)
      .get(`/v1/jobs?cursor=${jobId}`)
      .set('Authorization', attacker.bearer);
    expect(res.status).toBe(200);
    expect((res.body as HistoryPage).jobs).toEqual([]);
  });
});

describe('cross-user isolation on every job-scoped route', () => {
  it('status, audio, and history behave identically for "not mine" and "does not exist"', async () => {
    const owner = await createUserWithKey();
    const attacker = await createUserWithKey();
    const jobId = await submitJob(owner.bearer);
    const ghostId = '00000000-0000-0000-0000-000000000000';

    for (const path of [`/v1/jobs/${jobId}`, `/v1/jobs/${jobId}/audio`]) {
      const ghostPath = path.replace(jobId, ghostId);
      const notMine = await request(ctx.app).get(path).set('Authorization', attacker.bearer);
      const notThere = await request(ctx.app).get(ghostPath).set('Authorization', attacker.bearer);
      expect(notMine.status).toBe(404);
      expect(notMine.status).toBe(notThere.status);
      expect(notMine.body).toEqual(notThere.body);
    }

    const history = await request(ctx.app).get('/v1/jobs').set('Authorization', attacker.bearer);
    expect((history.body as HistoryPage).jobs).toEqual([]);
  });
});

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/test-app.js';

const BENGALI = 'আগামীকাল সকালে আমাদের দলের সাপ্তাহিক সভা অনুষ্ঠিত হবে।';
const PASSWORD = 'a sufficiently long password';

let ctx: TestContext;
let logLines: string[];
let seq = 0;

async function createUserWithKey(): Promise<{ bearer: string; key: string; userId: string }> {
  seq += 1;
  const email = `obs-${Date.now()}-${seq}@example.com`;
  const registered = await request(ctx.app)
    .post('/v1/auth/register')
    .send({ email, password: PASSWORD });
  const basic = `Basic ${Buffer.from(`${email}:${PASSWORD}`).toString('base64')}`;
  const created = await request(ctx.app).post('/v1/keys').set('Authorization', basic);
  const key = (created.body as { key: string }).key;
  return { bearer: `Bearer ${key}`, key, userId: (registered.body as { id: string }).id };
}

beforeAll(async () => {
  logLines = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => void logLines.push(line) });
  ctx = await createTestContext(
    {
      TTS_QUEUE_NAME: 'tts-observability',
      TTS_RATE_LIMIT_PER_MINUTE: '1000',
      TTS_PENDING_CAP: '1',
      TTS_QUEUE_CAPACITY: '100',
    },
    { logger },
  );
});

afterAll(async () => {
  await ctx.close();
});

describe('request logging', () => {
  it('assigns a request id, returns it as a header, and logs JSON carrying it', async () => {
    const res = await request(ctx.app).get('/healthz');
    const requestId = res.headers['x-request-id'] as string;
    expect(requestId).toBeTruthy();

    const line = logLines.find((l) => l.includes(requestId));
    expect(line).toBeTruthy();
    const parsed = JSON.parse(line as string) as { req?: { id?: string } };
    expect(parsed.req?.id).toBe(requestId);
  });

  it('never logs passwords, raw API keys, or authorization headers', async () => {
    const user = await createUserWithKey();
    await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', user.bearer)
      .send({ text: BENGALI });

    const joined = logLines.join('');
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toContain(PASSWORD);
    expect(joined).not.toContain(user.key);
    expect(joined).not.toContain(user.bearer);
  });
});

describe('correlation id propagation', () => {
  it('stamps the queue payload with the request id of the submission', async () => {
    const user = await createUserWithKey();
    const res = await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', user.bearer)
      .send({ text: BENGALI });
    expect(res.status).toBe(202);

    const jobId = (res.body as { jobId: string }).jobId;
    const queued = await ctx.deps.queue.getJob(jobId);
    expect(queued?.data.correlationId).toBe(res.headers['x-request-id']);
  });
});

describe('GET /metrics', () => {
  it('exposes the expected metrics after driving traffic', async () => {
    const user = await createUserWithKey();

    // One accepted job, then a pending-cap rejection (cap is 1 here).
    const accepted = await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', user.bearer)
      .send({ text: BENGALI });
    expect(accepted.status).toBe(202);
    const rejected = await request(ctx.app)
      .post('/v1/tts')
      .set('Authorization', user.bearer)
      .send({ text: BENGALI });
    expect(rejected.status).toBe(429);

    // Complete the job the way the worker would, so a duration exists.
    const jobId = (accepted.body as { jobId: string }).jobId;
    const audioKey = `audio/${user.userId}/${jobId}.wav`;
    await ctx.deps.s3.send(
      new PutObjectCommand({
        Bucket: ctx.deps.config.S3_BUCKET,
        Key: audioKey,
        Body: Buffer.from('RIFF'),
      }),
    );
    await ctx.deps.prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        audioKey,
        startedAt: new Date(Date.now() - 3000),
        completedAt: new Date(),
      },
    });

    const res = await request(ctx.app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const body = res.text;
    expect(body).toContain('tts_queue_depth');
    expect(body).toMatch(/tts_jobs_by_status\{status="COMPLETED"\} [1-9]/);
    expect(body).toContain('tts_job_duration_seconds_bucket');
    expect(body).toMatch(/tts_job_duration_seconds_count\{status="COMPLETED"\} [1-9]/);
    expect(body).toContain('http_request_duration_seconds_bucket');
    expect(body).toMatch(/tts_gate_rejections_total\{gate="pending_cap"\} [1-9]/);
    // Routes are labeled by pattern, not by concrete URL (bounded cardinality).
    expect(body).toContain('route="/v1/tts"');
    expect(body).not.toContain(jobId);
  });

  it('requires no authentication', async () => {
    const res = await request(ctx.app).get('/metrics');
    expect(res.status).toBe(200);
  });
});

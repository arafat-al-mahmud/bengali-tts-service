import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gracefulShutdown } from '../src/lib/shutdown.js';
import { createTestContext, type TestContext } from './helpers/test-app.js';

const BENGALI = 'আজকের সভা সকাল দশটায় শুরু হবে।';
const QUEUE_NAME = 'tts-sse';

let ctx: TestContext;
let server: Server;
let baseUrl: string;
let seq = 0;

async function createUserWithKey(): Promise<{ bearer: string; userId: string }> {
  seq += 1;
  const email = `sse-${Date.now()}-${seq}@example.com`;
  const password = 'a sufficiently long password';
  const registered = await request(ctx.app).post('/v1/auth/register').send({ email, password });
  const basic = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
  const created = await request(ctx.app).post('/v1/keys').set('Authorization', basic);
  return {
    bearer: `Bearer ${(created.body as { key: string }).key}`,
    userId: (registered.body as { id: string }).id,
  };
}

/** Seeds a job row directly so tests control every status transition. */
async function seedJob(userId: string, status: 'QUEUED' | 'ACTIVE' = 'QUEUED'): Promise<string> {
  const job = await ctx.deps.prisma.job.create({
    data: { userId, inputText: BENGALI, status },
  });
  return job.id;
}

interface SseEvent {
  event: string;
  data: { id: string; status: string; audioUrl?: string; error?: { code: string } };
}

interface SseStream {
  status: number;
  /** Resolves with the next event, or null once the server ends the stream. */
  next: () => Promise<SseEvent | null>;
}

async function openStream(path: string, bearer: string): Promise<SseStream> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: bearer, Accept: 'text/event-stream' },
  });
  if (!response.ok || response.body === null) {
    return { status: response.status, next: () => Promise.resolve(null) };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pending: SseEvent[] = [];
  let buffer = '';
  let done = false;

  async function next(): Promise<SseEvent | null> {
    while (pending.length === 0 && !done) {
      const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (chunk.done) {
        done = true;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event: SseEvent = { event: '', data: { id: '', status: '' } };
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event.event = line.slice('event: '.length);
          if (line.startsWith('data: ')) {
            event.data = JSON.parse(line.slice('data: '.length)) as SseEvent['data'];
          }
        }
        pending.push(event);
        boundary = buffer.indexOf('\n\n');
      }
    }
    return pending.shift() ?? null;
  }

  return { status: response.status, next };
}

beforeAll(async () => {
  ctx = await createTestContext({
    SSE_POLL_INTERVAL_MS: '50',
    TTS_QUEUE_NAME: QUEUE_NAME,
  });
  server = createServer(ctx.app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  ctx.deps.sse.closeAll();
  await new Promise((resolve) => server.close(resolve));
  await ctx.close();
});

describe('GET /v1/jobs/:id/events', () => {
  it('streams status transitions and closes after a terminal status', async () => {
    const user = await createUserWithKey();
    const jobId = await seedJob(user.userId);

    const stream = await openStream(`/v1/jobs/${jobId}/events`, user.bearer);
    expect(stream.status).toBe(200);

    const first = await stream.next();
    expect(first).toMatchObject({ event: 'status', data: { id: jobId, status: 'QUEUED' } });

    await ctx.deps.prisma.job.update({
      where: { id: jobId },
      data: { status: 'ACTIVE', startedAt: new Date() },
    });
    const second = await stream.next();
    expect(second).toMatchObject({ event: 'status', data: { status: 'ACTIVE' } });

    await ctx.deps.prisma.job.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', audioKey: `audio/${user.userId}/${jobId}.wav`, completedAt: new Date() },
    });
    const third = await stream.next();
    expect(third).toMatchObject({
      event: 'status',
      data: { status: 'COMPLETED', audioUrl: `/v1/jobs/${jobId}/audio` },
    });

    expect(await stream.next()).toBeNull();
  });

  it('sends the current status immediately to a mid-lifecycle subscriber', async () => {
    const user = await createUserWithKey();
    const jobId = await seedJob(user.userId, 'ACTIVE');

    const stream = await openStream(`/v1/jobs/${jobId}/events`, user.bearer);
    const first = await stream.next();
    expect(first).toMatchObject({ event: 'status', data: { status: 'ACTIVE' } });

    await ctx.deps.prisma.job.update({
      where: { id: jobId },
      data: { status: 'FAILED', errorCode: 'INTERNAL', errorMessage: 'Synthesis failed' },
    });
    const second = await stream.next();
    expect(second).toMatchObject({
      event: 'status',
      data: { status: 'FAILED', error: { code: 'INTERNAL' } },
    });
    expect(await stream.next()).toBeNull();
  });

  it('sends a single event and closes for an already-terminal job', async () => {
    const user = await createUserWithKey();
    const jobId = await seedJob(user.userId);
    await ctx.deps.prisma.job.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', audioKey: `audio/${user.userId}/${jobId}.wav` },
    });

    const stream = await openStream(`/v1/jobs/${jobId}/events`, user.bearer);
    const first = await stream.next();
    expect(first).toMatchObject({ event: 'status', data: { status: 'COMPLETED' } });
    expect(await stream.next()).toBeNull();
  });

  it("treats another user's job like a nonexistent one", async () => {
    const owner = await createUserWithKey();
    const other = await createUserWithKey();
    const jobId = await seedJob(owner.userId);

    const crossUser = await request(ctx.app)
      .get(`/v1/jobs/${jobId}/events`)
      .set('Authorization', other.bearer);
    const unknown = await request(ctx.app)
      .get('/v1/jobs/00000000-0000-0000-0000-000000000000/events')
      .set('Authorization', other.bearer);

    expect(crossUser.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(crossUser.body).toEqual(unknown.body);
  });

  it('requires an API key', async () => {
    const res = await request(ctx.app).get('/v1/jobs/some-id/events');
    expect(res.status).toBe(401);
  });

  it('graceful shutdown ends open streams and lets the server drain', async () => {
    const user = await createUserWithKey();
    const jobId = await seedJob(user.userId);

    // A dedicated server instance, so shutting it down cannot disturb the
    // shared one used by the other tests.
    const shutdownServer = createServer(ctx.app);
    await new Promise<void>((resolve) => shutdownServer.listen(0, resolve));
    const address = shutdownServer.address();
    if (address === null || typeof address === 'string') throw new Error('no server port');

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/jobs/${jobId}/events`, {
      headers: { Authorization: user.bearer, Accept: 'text/event-stream' },
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('no response body');
    // Consume the snapshot event so the stream is known to be live.
    await reader.read();

    const exitCode = await new Promise<number>((resolve) => {
      // Mirrors the production shutdown sequence in server.ts: end SSE
      // streams first, or the drain would wait on them until the failsafe.
      ctx.deps.sse.closeAll();
      gracefulShutdown(shutdownServer, () => Promise.resolve(), resolve, 5000);
    });

    expect(exitCode).toBe(0);
    // The client observes end-of-stream, not an abrupt socket error.
    let done = false;
    while (!done) done = (await reader.read()).done;
  });
});

describe('end to end with the fake engine', () => {
  const workerDir = fileURLToPath(new URL('../../worker', import.meta.url));
  const pythonBin = `${workerDir}/.venv/bin/python`;
  let workerProc: ChildProcess | undefined;

  afterAll(async () => {
    if (workerProc === undefined) return;
    workerProc.kill('SIGTERM');
    await new Promise((resolve) => workerProc?.once('exit', resolve));
  });

  it.skipIf(!existsSync(pythonBin))(
    'streams a submitted job through to COMPLETED and playable audio',
    { timeout: 30_000 },
    async () => {
      workerProc = spawn(pythonBin, ['-m', 'worker.main'], {
        cwd: workerDir,
        env: {
          ...process.env,
          DATABASE_URL: ctx.deps.config.DATABASE_URL,
          REDIS_URL: ctx.deps.config.REDIS_URL,
          S3_ENDPOINT: ctx.deps.config.S3_ENDPOINT,
          S3_ACCESS_KEY: ctx.deps.config.S3_ACCESS_KEY,
          S3_SECRET_KEY: ctx.deps.config.S3_SECRET_KEY,
          S3_BUCKET: ctx.deps.config.S3_BUCKET,
          TTS_QUEUE_NAME: QUEUE_NAME,
          TTS_ENGINE: 'fake',
          // Long enough for the stream to observe the ACTIVE state.
          TTS_FAKE_DELAY_SECONDS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker never became ready')), 20_000);
        workerProc?.stdout?.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('worker ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
        workerProc?.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`worker exited early with code ${String(code)}`));
        });
      });

      const user = await createUserWithKey();
      const submitted = await request(ctx.app)
        .post('/v1/tts')
        .set('Authorization', user.bearer)
        .send({ text: BENGALI });
      expect(submitted.status).toBe(202);
      const jobId = (submitted.body as { jobId: string }).jobId;

      const stream = await openStream(`/v1/jobs/${jobId}/events`, user.bearer);
      const statuses: string[] = [];
      let event = await stream.next();
      while (event !== null) {
        statuses.push(event.data.status);
        event = await stream.next();
      }
      // The snapshot may catch the job in QUEUED or already ACTIVE; the
      // stream must end at COMPLETED either way.
      expect(statuses.length).toBeGreaterThanOrEqual(2);
      expect(statuses.at(-1)).toBe('COMPLETED');
      expect(statuses).toContain('ACTIVE');

      const audio = await request(ctx.app)
        .get(`/v1/jobs/${jobId}/audio`)
        .set('Authorization', user.bearer);
      expect(audio.status).toBe(200);
      expect(audio.headers['content-type']).toContain('audio/wav');
    },
  );
});

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gracefulShutdown } from '../src/lib/shutdown.js';
import { createTestContext, type TestContext } from './helpers/test-app.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

/** Raw client without keep-alive so drained sockets close promptly. */
function post(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers, agent: false },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitForConnection(server: ReturnType<TestContext['app']['listen']>): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const count = await new Promise<number>((resolve, reject) => {
      server.getConnections((err, n) => (err ? reject(err) : resolve(n)));
    });
    if (count > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('request never reached the server');
}

describe('graceful shutdown', () => {
  it('drains the in-flight request, runs cleanup, then refuses new connections', async () => {
    const email = `shutdown-${Date.now()}@example.com`;
    const password = 'a sufficiently long password';
    await request(ctx.app).post('/v1/auth/register').send({ email, password });
    const basic = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;

    const server = ctx.app.listen(0);
    const port = (server.address() as AddressInfo).port;

    // bcrypt verification makes this request slow enough to still be in
    // flight when shutdown starts.
    const inFlight = post(port, '/v1/keys', { Authorization: basic });
    await waitForConnection(server);

    let cleanedUp = false;
    const exitCode = new Promise<number>((resolve) => {
      gracefulShutdown(
        server,
        () => {
          cleanedUp = true;
          return Promise.resolve();
        },
        resolve,
        5_000,
      );
    });

    const drained = await inFlight;
    expect(drained.status).toBe(201);

    expect(await exitCode).toBe(0);
    expect(cleanedUp).toBe(true);

    await expect(post(port, '/v1/keys', { Authorization: basic })).rejects.toThrow();
  });
});

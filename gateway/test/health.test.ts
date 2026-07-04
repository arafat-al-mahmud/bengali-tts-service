import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/test-app.js';

describe('health endpoints', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('GET /healthz returns 200', async () => {
    const res = await request(ctx.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 200 with all dependencies reachable', async () => {
    const res = await request(ctx.app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok', storage: 'ok' },
    });
  });

  it('GET /readyz returns 503 when a dependency is unreachable', async () => {
    const broken = await createTestContext();
    broken.deps.redis.disconnect();
    const res = await request(broken.app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ checks: { redis: 'unreachable' } });
    await broken.close();
  });
});

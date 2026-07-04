import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/test-app.js';

let ctx: TestContext;
let seq = 0;

function uniqueEmail(): string {
  seq += 1;
  return `user-${Date.now()}-${seq}@example.com`;
}

function basicAuth(email: string, password: string): string {
  return `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

describe('POST /v1/auth/register', () => {
  it('registers a user and never returns password material', async () => {
    const email = uniqueEmail();
    const res = await request(ctx.app)
      .post('/v1/auth/register')
      .send({ email, password: 'correct horse battery' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email });
    expect(res.body).toHaveProperty('id');
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('rejects a duplicate email with a machine-readable code', async () => {
    const email = uniqueEmail();
    await request(ctx.app).post('/v1/auth/register').send({ email, password: 'password-one' });
    const res = await request(ctx.app)
      .post('/v1/auth/register')
      .send({ email, password: 'password-two' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'EMAIL_TAKEN' } });
  });

  it('rejects invalid input with a validation error', async () => {
    const res = await request(ctx.app)
      .post('/v1/auth/register')
      .send({ email: 'not-an-email', password: 'x' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('API key lifecycle', () => {
  async function registerUser(): Promise<{ email: string; password: string; auth: string }> {
    const email = uniqueEmail();
    const password = 'a sufficiently long password';
    await request(ctx.app).post('/v1/auth/register').send({ email, password });
    return { email, password, auth: basicAuth(email, password) };
  }

  it('creates a key, shows the full key exactly once, lists only prefix afterwards', async () => {
    const user = await registerUser();

    const created = await request(ctx.app).post('/v1/keys').set('Authorization', user.auth);
    expect(created.status).toBe(201);
    const { key, keyPrefix } = created.body as { key: string; keyPrefix: string };
    expect(key).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(keyPrefix)).toBe(true);

    const listed = await request(ctx.app).get('/v1/keys').set('Authorization', user.auth);
    expect(listed.status).toBe(200);
    const keys = (listed.body as { keys: Array<Record<string, unknown>> }).keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ keyPrefix });
    expect(JSON.stringify(listed.body)).not.toContain(key);
  });

  it('rejects key management with bad credentials', async () => {
    const user = await registerUser();
    const res = await request(ctx.app)
      .post('/v1/keys')
      .set('Authorization', basicAuth(user.email, 'wrong password'));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
  });

  it('authenticates API requests with a valid key and tracks last use', async () => {
    const user = await registerUser();
    const created = await request(ctx.app).post('/v1/keys').set('Authorization', user.auth);
    const { key } = created.body as { key: string };

    const whoami = await request(ctx.app).get('/v1/me').set('Authorization', `Bearer ${key}`);
    expect(whoami.status).toBe(200);
    expect(whoami.body).toMatchObject({ email: user.email });

    const listed = await request(ctx.app).get('/v1/keys').set('Authorization', user.auth);
    const keys = (listed.body as { keys: Array<{ lastUsedAt: string | null }> }).keys;
    expect(keys[0]?.lastUsedAt).toBeTruthy();
  });

  it('rejects unknown and malformed keys with distinct codes', async () => {
    const unknown = await request(ctx.app)
      .get('/v1/me')
      .set('Authorization', 'Bearer sk_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(unknown.status).toBe(401);
    expect(unknown.body).toMatchObject({ error: { code: 'INVALID_API_KEY' } });

    const missing = await request(ctx.app).get('/v1/me');
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ error: { code: 'MISSING_API_KEY' } });
  });

  it('supports multiple active keys; revoking one leaves the others working', async () => {
    const user = await registerUser();
    const first = await request(ctx.app).post('/v1/keys').set('Authorization', user.auth);
    const second = await request(ctx.app).post('/v1/keys').set('Authorization', user.auth);
    const firstKey = (first.body as { key: string }).key;
    const secondKey = (second.body as { key: string }).key;
    const firstId = (first.body as { id: string }).id;

    const revoked = await request(ctx.app)
      .delete(`/v1/keys/${firstId}`)
      .set('Authorization', user.auth);
    expect(revoked.status).toBe(204);

    const withRevoked = await request(ctx.app)
      .get('/v1/me')
      .set('Authorization', `Bearer ${firstKey}`);
    expect(withRevoked.status).toBe(401);
    expect(withRevoked.body).toMatchObject({ error: { code: 'REVOKED_API_KEY' } });

    const withActive = await request(ctx.app)
      .get('/v1/me')
      .set('Authorization', `Bearer ${secondKey}`);
    expect(withActive.status).toBe(200);
  });

  it('revoking another user\'s key behaves like a nonexistent key', async () => {
    const owner = await registerUser();
    const attacker = await registerUser();
    const created = await request(ctx.app).post('/v1/keys').set('Authorization', owner.auth);
    const keyId = (created.body as { id: string }).id;

    const res = await request(ctx.app)
      .delete(`/v1/keys/${keyId}`)
      .set('Authorization', attacker.auth);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

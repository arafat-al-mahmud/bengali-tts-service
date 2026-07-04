import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { checkBucket } from '../lib/storage.js';

type CheckResult = 'ok' | 'unreachable';

const CHECK_TIMEOUT_MS = 2_000;

async function check(fn: () => Promise<unknown>): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  // Clients retry while a dependency is down, so a probe must fail fast
  // instead of queueing behind a reconnecting connection.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('check timed out')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([fn(), timeout]);
    return 'ok';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

export function healthRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (_req, res) => {
    const [postgres, redis, storage] = await Promise.all([
      check(() => deps.prisma.$queryRaw`SELECT 1`),
      check(() => deps.redis.ping()),
      check(() => checkBucket(deps.s3, deps.config.S3_BUCKET)),
    ]);
    const checks = { postgres, redis, storage };
    const ready = Object.values(checks).every((c) => c === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks });
  });

  return router;
}

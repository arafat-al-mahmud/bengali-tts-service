import { Effect } from 'effect';
import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { checkBucket, StorageService } from '../lib/storage.js';

type CheckResult = 'ok' | 'unreachable';

const CHECK_TIMEOUT = '2 seconds';

/**
 * One dependency check, reduced to a word.
 *
 * Clients retry while a dependency is down, so a probe must answer even
 * when the thing it is probing does not. The deadline belongs to the
 * runtime here: there is no timer handle to remember to clear, and no
 * arrangement of failures that leaves the probe waiting. Whatever happens
 * — refusal, crash, or silence past the deadline — the answer is a word.
 *
 * The deadline stops us waiting; it cannot cancel a query already in
 * flight, which is also true of the response it replaces.
 */
function probe<E>(check: Effect.Effect<unknown, E>): Effect.Effect<CheckResult> {
  return check.pipe(
    Effect.timeout(CHECK_TIMEOUT),
    Effect.as<CheckResult>('ok'),
    Effect.catchAll(() => Effect.succeed<CheckResult>('unreachable')),
    Effect.catchAllDefect(() => Effect.succeed<CheckResult>('unreachable')),
  );
}

export function healthRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (_req, res) => {
    // All three run at once and the slowest sets the pace, bounded by the
    // per-check deadline above.
    const checks = await Effect.runPromise(
      Effect.all(
        {
          postgres: probe(Effect.tryPromise(() => deps.prisma.$queryRaw`SELECT 1`)),
          redis: probe(Effect.tryPromise(() => deps.redis.ping())),
          storage: probe(
            checkBucket(deps.config.S3_BUCKET).pipe(
              Effect.provideService(StorageService, deps.s3),
            ),
          ),
        },
        { concurrency: 'unbounded' },
      ),
    );

    const ready = Object.values(checks).every((c) => c === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks });
  });

  return router;
}

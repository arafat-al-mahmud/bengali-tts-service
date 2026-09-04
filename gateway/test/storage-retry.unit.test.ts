import { Effect, Fiber, TestContext, TestClock } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  BUCKET_BOOTSTRAP_RETRY,
  isTransient,
  StorageUnavailable,
  TRANSIENT_READ_RETRY,
} from '../src/lib/storage.js';

/**
 * These run on a clock the test controls, so a fifteen-second backoff is
 * exercised in full without the suite waiting fifteen seconds. `adjust`
 * moves virtual time forward; nothing sleeps for real.
 */
function runWithTestClock<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, TestContext.TestContext));
}

const unavailable = (status?: number) =>
  new StorageUnavailable({
    operation: 'test',
    cause: status === undefined ? new Error('socket hang up') : { $metadata: { httpStatusCode: status } },
  });

/** Fails for the first `failures` attempts, then succeeds. */
function flaky(failures: number, counter: { attempts: number }, status?: number) {
  return Effect.suspend(() => {
    counter.attempts += 1;
    return counter.attempts <= failures ? Effect.fail(unavailable(status)) : Effect.succeed('ok');
  });
}

describe('bucket bootstrap retry', () => {
  it('keeps trying while storage is still coming up', async () => {
    const counter = { attempts: 0 };

    await runWithTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          flaky(3, counter).pipe(Effect.retry(BUCKET_BOOTSTRAP_RETRY)),
        );
        // Well past the schedule's total budget; the fiber finishes as soon
        // as its attempt succeeds, so this does not pad the test.
        yield* TestClock.adjust('60 seconds');
        const result = yield* Fiber.join(fiber);
        expect(result).toBe('ok');
      }),
    );

    expect(counter.attempts).toBe(4);
  });

  it('gives up rather than retrying forever when storage is absent', async () => {
    const counter = { attempts: 0 };

    const outcome = await runWithTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          flaky(Number.MAX_SAFE_INTEGER, counter).pipe(
            Effect.retry(BUCKET_BOOTSTRAP_RETRY),
            Effect.either,
          ),
        );
        yield* TestClock.adjust('60 seconds');
        return yield* Fiber.join(fiber);
      }),
    );

    expect(outcome._tag).toBe('Left');
    // One initial attempt plus the schedule's six retries: boot fails
    // instead of hanging on a dependency that is never coming.
    expect(counter.attempts).toBe(7);
  });
});

describe('audio read retry', () => {
  it('retries a connection that never reached storage', async () => {
    const counter = { attempts: 0 };

    await runWithTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          flaky(2, counter).pipe(
            Effect.retry({ while: isTransient, schedule: TRANSIENT_READ_RETRY }),
          ),
        );
        yield* TestClock.adjust('10 seconds');
        yield* Fiber.join(fiber);
      }),
    );

    expect(counter.attempts).toBe(3);
  });

  it('does not retry a missing object', async () => {
    const counter = { attempts: 0 };

    const outcome = await runWithTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          flaky(Number.MAX_SAFE_INTEGER, counter, 404).pipe(
            Effect.retry({ while: isTransient, schedule: TRANSIENT_READ_RETRY }),
            Effect.either,
          ),
        );
        yield* TestClock.adjust('10 seconds');
        return yield* Fiber.join(fiber);
      }),
    );

    expect(outcome._tag).toBe('Left');
    // A 404 is an answer, so waiting to ask again would only delay it.
    expect(counter.attempts).toBe(1);
  });

  it('treats server-side failures as worth another attempt', () => {
    expect(isTransient(unavailable(503))).toBe(true);
    expect(isTransient(unavailable(429))).toBe(true);
    expect(isTransient(unavailable())).toBe(true);
    expect(isTransient(unavailable(404))).toBe(false);
    expect(isTransient(unavailable(403))).toBe(false);
  });
});

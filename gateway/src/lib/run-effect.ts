import { Cause, Effect, Exit, Option } from 'effect';
import type { GatewayRuntime } from './tracing.js';

/**
 * The boundary between Effect code and an Express handler.
 *
 * Running on the process runtime rather than a fresh one is what lets
 * spans from a single request belong to a single trace; a new runtime per
 * call would start a new trace per call.
 *
 * A failure the Effect declares in its type is rethrown as-is for the
 * error middleware to render. Anything else — a genuine crash the type
 * never promised — is rethrown untouched, keeping its original message and
 * stack for the logs and still reaching the client as a sanitized 500.
 */
export async function runEffect<A, E>(
  runtime: GatewayRuntime,
  effect: Effect.Effect<A, E>,
): Promise<A> {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const expected = Cause.failureOption(exit.cause);
  throw Option.isSome(expected) ? expected.value : Cause.squash(exit.cause);
}

/**
 * Lifts a step that throws into the error channel with its error intact.
 *
 * Used where the thing being called still signals failure by throwing —
 * Prisma, and the Zod-backed validators. The error type stays `unknown`
 * because that is the honest description of what a throw carries; the
 * refusals in errors.ts still render correctly because the edge
 * recognises them by tag rather than by static type.
 */
export const attempt = <A>(run: () => A): Effect.Effect<A, unknown> =>
  Effect.try({ try: run, catch: (cause) => cause });

/** The same, for a promise. */
export const attemptPromise = <A>(run: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: run, catch: (cause) => cause });

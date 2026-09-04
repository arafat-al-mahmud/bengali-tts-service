import { Cause, Effect, Exit, Option } from 'effect';
import type { ApiError } from './errors.js';

/**
 * The boundary between Effect code and an Express handler.
 *
 * A failure the Effect declares in its type is handed to `toApiError` and
 * thrown, so the existing error middleware renders it exactly as before.
 * Anything else — a genuine crash the type never promised — is rethrown
 * untouched, keeping its original message and stack for the logs and still
 * surfacing to the client as a sanitized 500.
 */
export async function runEffect<A, E>(
  effect: Effect.Effect<A, E>,
  toApiError: (error: E) => ApiError,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const expected = Cause.failureOption(exit.cause);
  throw Option.isSome(expected) ? toApiError(expected.value) : Cause.squash(exit.cause);
}

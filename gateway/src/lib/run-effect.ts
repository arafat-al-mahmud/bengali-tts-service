import { Cause, Effect, Exit, Option } from 'effect';

/**
 * The boundary between Effect code and an Express handler.
 *
 * A failure the Effect declares in its type is rethrown as-is for the error
 * middleware to render. Anything else — a genuine crash the type never
 * promised — is rethrown untouched, keeping its original message and stack
 * for the logs and still reaching the client as a sanitized 500.
 */
export async function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const expected = Cause.failureOption(exit.cause);
  throw Option.isSome(expected) ? expected.value : Cause.squash(exit.cause);
}

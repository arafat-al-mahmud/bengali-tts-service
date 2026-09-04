import { Data } from 'effect';
import type { NextFunction, Request, Response } from 'express';

/**
 * Every way a request can be refused, one type per reason.
 *
 * These carry no HTTP vocabulary: a rate limit is a rate limit whether it
 * is reported over HTTP, logged, or handled in code. The status and code a
 * client sees are decided once, in RENDERERS below.
 */
export class Unauthenticated extends Data.TaggedError('Unauthenticated') {}
export class MissingCredentials extends Data.TaggedError('MissingCredentials') {}
export class InvalidCredentials extends Data.TaggedError('InvalidCredentials') {}
export class MissingApiKey extends Data.TaggedError('MissingApiKey') {}
export class InvalidApiKey extends Data.TaggedError('InvalidApiKey') {}
export class RevokedApiKey extends Data.TaggedError('RevokedApiKey') {}
export class EmailTaken extends Data.TaggedError('EmailTaken') {}
export class NotFound extends Data.TaggedError('NotFound') {}
export class InvalidParameter extends Data.TaggedError('InvalidParameter')<{
  readonly name: string;
}> {}
export class ValidationFailed extends Data.TaggedError('ValidationFailed')<{
  readonly message: string;
  readonly details?: unknown;
}> {}
export class RateLimited extends Data.TaggedError('RateLimited')<{
  readonly retryAfterSeconds: number;
}> {}
export class PendingCapExceeded extends Data.TaggedError('PendingCapExceeded') {}
export class QueueFull extends Data.TaggedError('QueueFull') {}
export class IdempotencyConflict extends Data.TaggedError('IdempotencyConflict') {}
export class JobFailed extends Data.TaggedError('JobFailed') {}
export class JobNotReady extends Data.TaggedError('JobNotReady') {}
export class TextEmpty extends Data.TaggedError('TextEmpty') {}
export class TextTooLong extends Data.TaggedError('TextTooLong')<{
  readonly maxLength: number;
  readonly actualLength: number;
}> {}
export class TextNotBengali extends Data.TaggedError('TextNotBengali')<{
  readonly ratio: number;
  readonly minimumRatio: number;
}> {}

export type DomainError =
  | Unauthenticated
  | MissingCredentials
  | InvalidCredentials
  | MissingApiKey
  | InvalidApiKey
  | RevokedApiKey
  | EmailTaken
  | NotFound
  | InvalidParameter
  | ValidationFailed
  | RateLimited
  | PendingCapExceeded
  | QueueFull
  | IdempotencyConflict
  | JobFailed
  | JobNotReady
  | TextEmpty
  | TextTooLong
  | TextNotBengali;

interface Rendering {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * The single place a refusal becomes an HTTP answer.
 *
 * The `satisfies` clause is the point of this table: adding a member to
 * DomainError without a row here is a compile error, so a new failure can
 * never reach a client as an accidental 500.
 */
const RENDERERS = {
  Unauthenticated: () => ({
    status: 401,
    code: 'UNAUTHENTICATED',
    message: 'Authentication required',
  }),
  MissingCredentials: () => ({
    status: 401,
    code: 'MISSING_CREDENTIALS',
    message: 'Provide email and password via Basic auth',
  }),
  InvalidCredentials: () => ({
    status: 401,
    code: 'INVALID_CREDENTIALS',
    message: 'Email or password is incorrect',
  }),
  MissingApiKey: () => ({
    status: 401,
    code: 'MISSING_API_KEY',
    message: 'Provide an API key via Bearer auth',
  }),
  InvalidApiKey: () => ({
    status: 401,
    code: 'INVALID_API_KEY',
    message: 'API key is not recognized',
  }),
  RevokedApiKey: () => ({
    status: 401,
    code: 'REVOKED_API_KEY',
    message: 'API key has been revoked',
  }),
  EmailTaken: () => ({
    status: 409,
    code: 'EMAIL_TAKEN',
    message: 'A user with this email already exists',
  }),
  NotFound: () => ({ status: 404, code: 'NOT_FOUND', message: 'Resource not found' }),
  InvalidParameter: (error: InvalidParameter) => ({
    status: 400,
    code: 'INVALID_PARAMETER',
    message: `Missing or invalid path parameter: ${error.name}`,
  }),
  ValidationFailed: (error: ValidationFailed) => ({
    status: 422,
    code: 'VALIDATION_ERROR',
    message: error.message,
    ...(error.details !== undefined && { details: error.details }),
  }),
  RateLimited: () => ({
    status: 429,
    code: 'RATE_LIMITED',
    message: 'Request rate limit exceeded; retry later',
  }),
  PendingCapExceeded: () => ({
    status: 429,
    code: 'PENDING_CAP_EXCEEDED',
    message: 'Too many unfinished jobs; wait for them to complete instead of retrying',
  }),
  QueueFull: () => ({
    status: 503,
    code: 'QUEUE_FULL',
    message: 'Service is at capacity; retry later',
  }),
  IdempotencyConflict: () => ({
    status: 409,
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'This Idempotency-Key was already used with different input text',
  }),
  JobFailed: () => ({
    status: 409,
    code: 'JOB_FAILED',
    message: 'Job failed; no audio was produced',
  }),
  JobNotReady: () => ({
    status: 409,
    code: 'JOB_NOT_READY',
    message: 'Job has not completed yet; keep polling',
  }),
  TextEmpty: () => ({ status: 422, code: 'TEXT_EMPTY', message: 'Text must not be empty' }),
  TextTooLong: (error: TextTooLong) => ({
    status: 422,
    code: 'TEXT_TOO_LONG',
    message: `Text exceeds the maximum length of ${error.maxLength} characters`,
    details: { maxLength: error.maxLength, actualLength: error.actualLength },
  }),
  TextNotBengali: () => ({
    status: 422,
    code: 'TEXT_NOT_BENGALI',
    message: 'Text must be predominantly Bengali (at least half of non-whitespace characters)',
  }),
} satisfies { [T in DomainError['_tag']]: (error: Extract<DomainError, { _tag: T }>) => Rendering };

export function toRendering(error: DomainError): Rendering {
  return (RENDERERS[error._tag] as (e: DomainError) => Rendering)(error);
}

/** A refusal we defined, as opposed to something that genuinely went wrong. */
export function isDomainError(err: unknown): err is DomainError {
  return (
    err instanceof Error &&
    '_tag' in err &&
    typeof err._tag === 'string' &&
    Object.hasOwn(RENDERERS, err._tag)
  );
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  res.status(status).json({ error: { code, message, ...(details !== undefined && { details }) } });
}

export function notFoundHandler(_req: Request, res: Response): void {
  sendError(res, 404, 'NOT_FOUND', 'Resource not found');
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (isDomainError(err)) {
    // The one refusal that also carries a header: tell the client how long
    // to wait rather than making it guess.
    if (err._tag === 'RateLimited') {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }
    const { status, code, message, details } = toRendering(err);
    sendError(res, status, code, message, details);
    return;
  }
  // Body parse failures surface here as SyntaxError with a status.
  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    sendError(res, 400, 'MALFORMED_JSON', 'Request body is not valid JSON');
    return;
  }
  // Anything else is internal; the envelope stays sanitized and the detail
  // goes to the logger attached by pino-http (or the console in tests).
  res.locals.internalError = err;
  sendError(res, 500, 'INTERNAL', 'Internal server error');
}

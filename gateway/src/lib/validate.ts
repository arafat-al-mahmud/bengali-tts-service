import type { Request } from 'express';
import type { ZodType } from 'zod';
import { ApiError } from './errors.js';

/** Route params are typed loosely by Express; jobs and keys need exactly one string. */
export function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'INVALID_PARAMETER', `Missing or invalid path parameter: ${name}`);
  }
  return value;
}

export function validate<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new ApiError(422, 'VALIDATION_ERROR', 'Request validation failed', details);
  }
  return parsed.data;
}

import type { Request } from 'express';
import type { ZodType } from 'zod';
import { InvalidParameter, ValidationFailed } from './errors.js';

/** Route params are typed loosely by Express; jobs and keys need exactly one string. */
export function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidParameter({ name });
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
    throw new ValidationFailed({ message: 'Request validation failed', details });
  }
  return parsed.data;
}

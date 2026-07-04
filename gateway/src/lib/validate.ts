import type { ZodType } from 'zod';
import { ApiError } from './errors.js';

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

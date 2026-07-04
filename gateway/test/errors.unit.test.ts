import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/lib/errors.js';

function invokeHandler(err: unknown): { status: number; body: unknown } {
  const captured = { status: 0, body: undefined as unknown };
  const res = {
    locals: {} as Record<string, unknown>,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  };
  errorHandler(err, {} as Request, res as unknown as Response, (() => {}) as NextFunction);
  return captured;
}

describe('errorHandler sanitization', () => {
  it('reduces an unexpected error to the bare INTERNAL envelope', () => {
    const err = new Error(
      'connect ECONNREFUSED postgresql://tts:secret-password@10.0.0.5:5432/tts',
    );
    const { status, body } = invokeHandler(err);

    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  it('leaks neither message, stack, nor infrastructure detail for any thrown shape', () => {
    const errors: unknown[] = [
      new Error('at /app/src/lib/secret.ts:42:1'),
      { stack: 'Error: boom\n  at handler', config: { redis: 'redis://10.0.0.9' } },
      'raw string with password=hunter2',
    ];
    for (const err of errors) {
      const { status, body } = invokeHandler(err);
      expect(status).toBe(500);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('at /');
      expect(serialized).not.toContain('10.0.0');
      expect(serialized).not.toContain('stack');
    }
  });
});

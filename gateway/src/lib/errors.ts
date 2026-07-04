import type { NextFunction, Request, Response } from 'express';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
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
  if (err instanceof ApiError) {
    sendError(res, err.status, err.code, err.message, err.details);
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

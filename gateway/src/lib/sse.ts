import type { Response } from 'express';

/**
 * Registry of open SSE responses. Event streams are long-lived, so a plain
 * `server.close()` would wait on them until the shutdown failsafe fires;
 * ending them first lets the server drain promptly. See server.ts.
 */
export interface SseHub {
  add(res: Response): void;
  remove(res: Response): void;
  closeAll(): void;
}

export function createSseHub(): SseHub {
  const streams = new Set<Response>();
  return {
    add: (res) => streams.add(res),
    remove: (res) => streams.delete(res),
    closeAll: () => {
      for (const res of streams) res.end();
      streams.clear();
    },
  };
}

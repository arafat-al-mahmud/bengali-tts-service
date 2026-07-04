import type { Server } from 'node:http';

/**
 * Stops accepting new connections, waits for in-flight requests to finish,
 * then runs cleanup and reports an exit code. Idle keep-alive sockets are
 * closed immediately so draining does not wait on them, and a failsafe
 * timer guarantees an exit even with stuck connections.
 */
export function gracefulShutdown(
  server: Server,
  cleanup: () => Promise<void>,
  onExit: (code: number) => void,
  timeoutMs = 10_000,
): void {
  server.close(() => {
    void cleanup()
      .then(() => onExit(0))
      .catch(() => onExit(1));
  });
  server.closeIdleConnections();
  setTimeout(() => onExit(1), timeoutMs).unref();
}

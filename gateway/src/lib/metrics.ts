import type { NextFunction, Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { PrismaClient } from './prisma.js';
import { queueDepth, type TtsQueue } from './queue.js';

export interface Metrics {
  registry: Registry;
  gateRejections: Counter<'gate'>;
  httpMiddleware: (req: Request, res: Response, next: NextFunction) => void;
}

const JOB_STATUSES = ['QUEUED', 'ACTIVE', 'COMPLETED', 'FAILED'] as const;

/**
 * All metrics live in a per-instance registry (never the prom-client
 * global one), so tests can build multiple apps without name collisions.
 * Queue and database gauges are computed lazily at scrape time.
 */
export function createMetrics(prisma: PrismaClient, queue: TtsQueue): Metrics {
  const registry = new Registry();

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency, labeled by route pattern for bounded cardinality',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const gateRejections = new Counter({
    name: 'tts_gate_rejections_total',
    help: 'Job submissions rejected, per backpressure gate',
    labelNames: ['gate'],
    registers: [registry],
  });

  new Gauge({
    name: 'tts_queue_depth',
    help: 'Jobs currently waiting, delayed, or running in the queue',
    registers: [registry],
    async collect() {
      this.set(await queueDepth(queue));
    },
  });

  new Gauge({
    name: 'tts_jobs_by_status',
    help: 'Number of job records per status',
    labelNames: ['status'],
    registers: [registry],
    async collect() {
      const rows = await prisma.job.groupBy({ by: ['status'], _count: { _all: true } });
      for (const status of JOB_STATUSES) {
        this.set({ status }, rows.find((r) => r.status === status)?._count._all ?? 0);
      }
    },
  });

  // Durations come from job rows at scrape time; only rows that reached a
  // terminal status since the previous scrape are observed, so each job is
  // counted once per process lifetime.
  let observedUpTo = new Date();
  new Histogram({
    name: 'tts_job_duration_seconds',
    help: 'Time from synthesis start to terminal status',
    labelNames: ['status'],
    buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600],
    registers: [registry],
    async collect() {
      const rows = await prisma.job.findMany({
        where: { completedAt: { gt: observedUpTo }, startedAt: { not: null } },
        select: { status: true, startedAt: true, completedAt: true },
      });
      for (const row of rows) {
        if (!row.startedAt || !row.completedAt) continue;
        this.observe(
          { status: row.status },
          (row.completedAt.getTime() - row.startedAt.getTime()) / 1000,
        );
        if (row.completedAt > observedUpTo) observedUpTo = row.completedAt;
      }
    },
  });

  function httpMiddleware(req: Request, res: Response, next: NextFunction): void {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      end({
        method: req.method,
        // The matched pattern (/v1/jobs/:id), never the concrete URL.
        route: (req.route as { path?: string } | undefined)?.path ?? 'unmatched',
        status: res.statusCode,
      });
    });
    next();
  }

  return { registry, gateRejections, httpMiddleware };
}

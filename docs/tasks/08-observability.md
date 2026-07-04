# 08 - Observability

Issue: [#9](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/9)

## What to build

Observability across both services. Structured JSON logs (pino in the gateway, structlog in the worker) sharing a correlation id that follows a request from submission through queueing, inference, and completion, so one grep traces a Job end to end. A Prometheus metrics endpoint on the gateway exposing queue depth, job duration histogram, jobs by status, HTTP request latencies, and rejection counters per Backpressure Gate.

Covers user stories 34-36.

## Acceptance criteria

- [x] Every log line in both services is JSON with a correlation id; a submitted Job's correlation id appears in gateway and worker logs for the same request
- [x] Metrics endpoint exposes queue depth, job duration histogram, jobs-by-status, HTTP latency, and per-gate rejection counters
- [x] Metrics endpoint exposure choice (internal, unauthenticated) is documented
- [x] Raw API keys and password material never appear in logs; a test guards this
- [x] Integration test scrapes the metrics endpoint and finds the expected metric names after driving traffic

## Blocked by

- [03 - Core tracer bullet](./03-core-tracer-bullet.md)

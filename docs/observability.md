# Observability

## Correlation ids

Every gateway request gets a request id (an incoming `x-request-id` header
is honored, otherwise a UUID is generated) which is:

- echoed back to the client as the `x-request-id` response header,
- attached to every gateway log line for that request (`req.id`),
- carried in the queue payload of a submitted job and bound into every
  worker log line for that synthesis (`correlation_id`).

So one grep traces a job end to end:

```bash
docker compose logs gateway worker | grep <request-id>
```

Logs are JSON in both services (pino in the gateway, structlog in the
worker). The `Authorization` header is redacted before logging; request and
response bodies are never logged, so passwords and raw API keys cannot
reach the log stream. A test asserts this.

## Metrics

`GET /metrics` on the gateway serves Prometheus text format.

| Metric | Type | Meaning |
| ------ | ---- | ------- |
| `tts_queue_depth` | gauge | Jobs waiting, delayed, or running, from BullMQ at scrape time |
| `tts_jobs_by_status{status}` | gauge | Job records per status, from the database at scrape time |
| `tts_job_duration_seconds{status}` | histogram | Synthesis start to terminal state, observed at scrape time for newly finished jobs |
| `tts_gate_rejections_total{gate}` | counter | Submissions rejected per backpressure gate (`rate_limit`, `pending_cap`, `queue_full`) |
| `http_request_duration_seconds{method,route,status}` | histogram | HTTP latency, labeled by route pattern (bounded cardinality) |

### Exposure choice

The endpoint is deliberately **unauthenticated**: Prometheus scrapers do
not carry per-user API keys, and the data is operational aggregate only,
with no per-user or per-job detail. It is meant to be reachable by an
internal scraper, not the public internet. In this compose demo it shares
the single published gateway port for convenience; in a real deployment
keep it internal (bind a separate management port, or restrict the route
at the ingress/network layer).

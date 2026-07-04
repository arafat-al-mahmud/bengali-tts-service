# Redis + BullMQ as the job queue between gateway and worker

TTS inference takes tens of seconds on CPU, so the API is asynchronous: submission returns 202 with a job id, and clients poll (or stream) status. The queue carrying jobs from the Node gateway to the Python worker is BullMQ on Redis - produced from Node with the standard `bullmq` package, consumed in Python with the official `bullmq` Python client. BullMQ supplies retries with backoff, per-job timeouts, and stalled-job recovery (re-queueing jobs whose worker died mid-run) that we would otherwise hand-roll, and Redis doubles as the rate-limiter store, keeping infrastructure to one extra container.

## Alternatives

- **Raw Redis Streams + consumer groups** - maximal control, no library magic; but reimplementing retry/backoff/dead-lettering is days of work and a prime source of subtle bugs.
- **RabbitMQ** - `prefetch=1` is an elegant backpressure fit for GPU workers; but a second infrastructure dependency when Redis is already required for rate limiting.
- **Database-backed queue** - polling-based, hand-rolled visibility timeouts; weakest option at this latency profile.

## Consequences

The BullMQ Python client is younger than the Node one; the worker's consumption surface is kept minimal (fetch job, report progress, complete/fail) so a swap to raw streams or another consumer stays contained.

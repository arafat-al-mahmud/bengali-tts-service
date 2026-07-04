# Load test

A k6 scenario that floods the API with concurrent users and shows the
three backpressure gates rejecting predictably while the worker keeps
draining at its own pace.

## Running it

Start the stack with the fake engine, a simulated 2 second inference
latency (so backlog is observable without real synthesis), and gate
limits sized to trip within a one-minute burst:

```bash
TTS_ENGINE=fake TTS_FAKE_DELAY_SECONDS=2 \
TTS_RATE_LIMIT_PER_MINUTE=30 TTS_PENDING_CAP=5 TTS_QUEUE_CAPACITY=60 \
docker compose up -d --build

k6 run load/tts-load.js
```

Tunables: `BASE_URL` (default `http://localhost:3000`), `USERS` (default
20), `BURST_DURATION` (default `60s`). The setup step seeds deterministic
users (`k6-user-<i>@example.com`), tolerates re-runs (registration may
answer EMAIL_TAKEN), and issues fresh API keys each run. The teardown
polls `tts_queue_depth` on `/metrics` until the backlog drains.

## Results (2026-07-04, Apple Silicon laptop, compose stack)

20 virtual users hammering `POST /v1/tts` for 60 seconds, each pausing
200-500 ms between requests:

| Outcome | Count | Meaning |
| ------- | ----- | ------- |
| 202 accepted | 89 | job created and queued |
| 429 `RATE_LIMITED` | 2212 | per-user token bucket empty |
| 429 `PENDING_CAP_EXCEEDED` | 50 | user already had 5 unfinished jobs |
| 503 `QUEUE_FULL` | 1041 | global backlog at 60 |
| unexpected responses | 0 | every response was one of the above |

- 3493 requests at ~18 req/s sustained; p95 latency 11 ms even while
  rejecting >97% of traffic. Rejections are cheap by design: every gate
  fires before a job row or queue entry exists.
- Queue drained 60 → 0 in 121 s after the burst: exactly the single-flight
  worker's pace (60 jobs x 2 s simulated inference), confirming inference
  concurrency stayed at one throughout.
- The acceptance count reconciles independently: 60 jobs left in the
  backlog at burst end + ~29 completed during the burst (0.5 jobs/s x 60 s)
  ≈ 89 accepted.
- Gate ordering is visible in the mix. Early in the burst users burn their
  30-token buckets fast, filling the queue (many early 202s, then
  `QUEUE_FULL` once depth hits 60). `PENDING_CAP_EXCEEDED` appears for
  users who caught the worker just after completions freed global slots
  while their own 5 were still pending. After the first minute of tokens,
  `RATE_LIMITED` dominates, throttling everyone to the refill rate.

## Interpretation

Under a 37x overload (18 req/s offered vs ~0.5 jobs/s of capacity), the
service stays responsive, degrades by policy instead of by accident, and
recovers to an empty queue with no manual intervention. Every rejection
tells the client what to do next: back off (`RATE_LIMITED`, with
Retry-After), wait for your own jobs (`PENDING_CAP_EXCEEDED`), or try
again later (`QUEUE_FULL`).

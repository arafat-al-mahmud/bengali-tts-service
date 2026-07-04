## Problem Statement

Producing natural Bengali speech requires a heavyweight neural TTS model (IndicF5) that takes tens of seconds of compute per utterance. Consumers of speech synthesis cannot run this model themselves, and cannot use a service that blocks, times out, or collapses when several people use it at once. They need a simple HTTP API where they can submit Bengali text, come back for a playable audio file, see their own request history, and trust that their data is invisible to other users, even when the service is under heavy load.

## Solution

A multi-user Bengali TTS API service. A User registers, obtains an API Key, and submits Input Text as a Job. Submission is instant: the service returns a job id immediately and processes the synthesis in the background, so slow inference never blocks the client. The User polls the Job until it completes, then downloads the Audio Result as a playable WAV. Job History is queryable and strictly private per User. Layered Backpressure Gates keep the service responsive under load, rejecting excess work early with clear, machine-readable errors instead of degrading for everyone.

## User Stories

### Registration & API Keys

1. As a new user, I want to register with my email and a password, so that I can obtain access to the service.
2. As a registered user, I want to create an API Key, so that I can authenticate my programmatic requests.
3. As a registered user, I want the full API Key shown exactly once at creation, so that I understand it cannot be retrieved later and must be stored securely.
4. As a registered user, I want to hold multiple API Keys at once, so that I can separate environments or rotate keys without downtime.
5. As a registered user, I want to list my API Keys (prefix, creation date, last-used), so that I can audit which keys exist without exposing secrets.
6. As a registered user, I want to revoke an API Key, so that a leaked or retired key immediately stops working.
7. As a user presenting a revoked or unknown API Key, I want an unambiguous 401 response, so that I know the credential itself is the problem.

### Job Submission

8. As an authenticated user, I want to submit Bengali Input Text and immediately receive a job id with a 202 response, so that my client never waits on slow inference.
9. As an authenticated user, I want the submission response to include a status URL and a suggested polling interval, so that my client knows how to follow up.
10. As an authenticated user, I want empty or whitespace-only text rejected with a 422 and a machine-readable error code, so that I can correct my request programmatically.
11. As an authenticated user, I want text exceeding the length cap rejected with a 422 that states the limit, so that I can split my content accordingly.
12. As an authenticated user, I want text that is not predominantly Bengali rejected with a 422, so that I don't waste minutes of compute producing garbage audio.
13. As an authenticated user, I want to submit text containing digits, punctuation, and occasional non-Bengali loanwords, so that real-world Bengali content is accepted.
14. As an authenticated user, I want to optionally supply an Idempotency Key on submission, so that a client-side retry returns the original Job instead of creating a duplicate.

### Job Tracking & Results

15. As an authenticated user, I want to poll a Job's status and see QUEUED, ACTIVE, COMPLETED, or FAILED, so that I always know where my request stands.
16. As an authenticated user, I want a FAILED Job to carry a machine-readable error code and a human-readable message, so that I can distinguish a timeout from invalid input from an internal failure.
17. As an authenticated user, I want to download the Audio Result of a completed Job as a playable WAV, so that I can use it directly in my application.
18. As an authenticated user, I want requesting audio for an unfinished Job to return a clear conflict-style response, so that my client can keep polling instead of misinterpreting the state.
19. As an authenticated user, I want to list my Job History with pagination, newest first, so that I can review past and pending work.
20. As an authenticated user, I want failed Jobs to remain visible in my Job History with their error codes, so that failures are auditable rather than silently vanishing.
21. As an authenticated user, I want to subscribe to a Job's status events as a stream, so that I can react to completion without polling. (stretch)

### Isolation

22. As an authenticated user, I want any attempt to read another user's Job, Job History, or Audio Result to fail as if the resource does not exist, so that my data is private and resource ids leak nothing.
23. As a service operator, I want ownership enforced at the storage layer via relational constraints, so that isolation does not depend on every handler remembering a check.

### Load & Fairness

24. As an authenticated user, I want a 429 with a Retry-After header when I exceed my per-minute Rate Limit, so that my client can back off correctly.
25. As an authenticated user, I want a 429 with a distinct error code when I exceed my Pending Cap, so that I know to wait for my running Jobs rather than slow down my request rate.
26. As any user, I want a 503 when the global Queue Capacity is full, so that the service degrades predictably instead of accepting work it cannot finish.
27. As a service operator, I want inference to run strictly one Job at a time per worker process, so that the compute device is never oversubscribed.
28. As a service operator, I want to scale throughput by adding worker processes, so that capacity grows without touching the API tier.

### Robustness

29. As an authenticated user, I want a Job that exceeds the inference timeout to be marked FAILED with a TIMEOUT code, so that a pathological input cannot occupy a worker forever.
30. As a service operator, I want transient inference failures retried once with backoff before the Job is marked FAILED, so that hiccups don't surface as user-visible errors.
31. As a service operator, I want Jobs whose worker died mid-run to be automatically re-queued, so that a crash never strands a Job in ACTIVE forever.
32. As an authenticated user, I want internal error details sanitized out of API responses, so that stack traces and infrastructure details never leak to clients.
33. As a service operator, I want the gateway to shut down gracefully (drain in-flight HTTP, stop accepting new work), so that deploys don't corrupt Job state.

### Operations

34. As a service operator, I want structured JSON logs with a correlation id that follows a request through submission, queueing, inference, and completion, so that I can trace any Job end to end with one grep.
35. As a service operator, I want liveness and readiness endpoints that verify the database, queue, and object store, so that orchestration can restart or hold traffic correctly.
36. As a service operator, I want Prometheus metrics for queue depth, job duration, jobs by status, HTTP latencies, and rejection counts, so that I can see saturation and set alerts.
37. As a service operator, I want a pre-provisioned dashboard showing those metrics, so that load behavior is visible at a glance. (stretch)
38. As a reviewing engineer, I want a load-test script with documented results, so that the backpressure behavior is demonstrated, not just claimed. (stretch)
39. As a new developer, I want the entire stack to start with a single compose command, so that I can run and test the service without bespoke setup.

## Implementation Decisions

All recorded as ADRs in `docs/adr/`; summary:

- **Two services** (ADR-0001): an Express + TypeScript gateway owning auth, validation, Backpressure Gates, and the Job API; a Python worker owning IndicF5 inference. The process boundary isolates crashes and lets workers scale independently on GPU hosts.
- **Queue** (ADR-0003): BullMQ on Redis; Node produces, the official Python BullMQ client consumes. BullMQ provides retry-with-backoff, per-job timeout, and stalled-job recovery. Redis doubles as the rate-limiter store.
- **Persistence** (ADR-0002): PostgreSQL via Prisma for Users, API Keys, and Job records. Job rows are the durable record; queue state stays in Redis. Committed SQL migrations. Indexes: unique on key hash, composite (user, created-at desc) for Job History pagination.
- **Audio storage** (ADR-0004): MinIO (S3-compatible); the worker uploads, the gateway streams to the client only after an ownership check. No presigned URLs: the auth middleware remains the single gate.
- **Auth**: bcrypt-hashed passwords; API Keys issued as `sk_live_<random>`, stored as SHA-256 hash plus display prefix, compared in constant time; revocation supported.
- **API contract**: versioned under `/v1`. Submit returns 202 with job id and status URL. Status, audio download, and paginated history endpoints. Consistent error envelope `{error: {code, message, details?}}` with machine-readable codes throughout.
- **Backpressure Gates**: per-user token-bucket Rate Limit (429 + Retry-After), then per-user Pending Cap (429, distinct code), then global Queue Capacity (503). All limits env-configurable.
- **Input validation**: zod at the gateway; non-empty, length-capped (~1000 chars), Bengali-dominant rule (at least 50% of non-whitespace codepoints in the Bengali Unicode block), 422 otherwise.
- **Worker**: single-flight inference per process; the TTS Engine sits behind an interface with a real IndicF5 implementation and a fake implementation selected by environment variable; one bundled Reference Voice; per-job timeout; one retry for transient errors; sanitized error codes persisted to the Job record.
- **Observability**: pino (gateway) and structlog (worker) JSON logs sharing a correlation id; liveness and readiness endpoints; prom-client metrics.
- **Runtime**: docker compose runs everything (gateway, worker, Postgres, Redis, MinIO); Prisma `migrate deploy` on startup; the model runs on CPU/MPS by default with a GPU env flag; monitoring (Prometheus + Grafana) behind an optional compose profile.

## Testing Decisions

- **Good tests here** assert external behavior at the HTTP boundary: status codes, response envelopes, isolation outcomes, header values. Never internal call structure. Infrastructure is real, not mocked.
- **HTTP seam (primary)**: Supertest against the Express app with real Postgres, Redis, and MinIO via testcontainers. Covers registration, key lifecycle, submission, polling, audio ownership, history pagination, every Backpressure Gate, and every validation rejection. The single most important test: user A cannot see user B's Job by any route.
- **TTS Engine seam (only new seam)**: the fake engine returns a valid WAV instantly, letting the full pipeline (enqueue, consume, upload, state transition) run in tests without real inference. Worker tests (pytest) enqueue real BullMQ jobs against real Redis and assert Job completion, object presence, and database state.
- **Queue is never mocked**: retry, timeout, and stalled-job behavior are tested against real BullMQ semantics.
- **E2E**: one black-box smoke script against `docker compose up` asserting a playable WAV from the full flow.
- **Unit tier**: pure logic only, e.g. the Bengali-dominance validator, key hashing, pagination parsing.
- **CI**: lint, typecheck, unit, and integration suites on every PR. No prior art; greenfield repo, these tests establish the patterns.

## Out of Scope

- Voice selection: one bundled Reference Voice only.
- Any frontend, dashboard UI for end users, or browser session auth (JWT/cookies).
- Multi-model support, non-Bengali languages, SSML, or audio formats beyond WAV.
- Billing, quotas beyond the Backpressure Gates, or organization/team accounts.
- Kubernetes manifests, cloud deployment, autoscaling: compose is the runtime; scaling paths are documented, not built.
- Distributed tracing (OpenTelemetry) and SLO tooling: documented as production hardening.
- Email verification and password reset flows.

## Further Notes

- Build order: scaffold + compose + schema, then auth, then Job API + gates, then worker + model integration (highest-risk item, do not defer past mid-build), then failure paths + observability, then stretch items in priority order: load-test script, dashboard, Idempotency Key, status streaming.
- IndicF5 model weights download at first worker start; document size and cache volume in setup instructions.
- CPU inference latency (tens of seconds) is acceptable and makes queue behavior easy to demonstrate; the GPU flag is documented for production-like latency.

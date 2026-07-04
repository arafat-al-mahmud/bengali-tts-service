# 07 - Failure paths

Issue: [#8](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/8)

## What to build

The unhappy paths. A Job exceeding the inference timeout is marked FAILED with a TIMEOUT code. Transient inference errors get one retry with backoff before FAILED. Jobs whose worker dies mid-run are detected via BullMQ stalled-job recovery and re-queued; processing is idempotent by job id so a re-run is safe. Client-visible errors are sanitized to machine-readable codes and messages while full detail goes to logs. The gateway shuts down gracefully: stops accepting work, drains in-flight requests.

Covers user stories 16, 29-33.

## Acceptance criteria

- [x] A job exceeding the timeout lands FAILED with code TIMEOUT and remains visible in Job History
- [x] A transiently failing job (fake engine failure injection) succeeds on retry; a persistently failing one lands FAILED after exactly one retry
- [x] Killing the worker mid-job results in the job being re-queued and completed by a restarted worker, not stranded in ACTIVE
- [x] No stack trace or infrastructure detail ever appears in an API response; tests assert the sanitized envelope
- [x] SIGTERM on the gateway drains in-flight HTTP requests before exit
- [x] Failure-path tests run against real BullMQ semantics (no queue mocking)

## Blocked by

- [03 - Core tracer bullet](./03-core-tracer-bullet.md)

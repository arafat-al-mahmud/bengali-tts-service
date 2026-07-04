# 12 - Job status stream (SSE)

Issue: [#13](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/13)

## What to build

A Server-Sent Events endpoint per Job streaming status transitions (QUEUED, ACTIVE, COMPLETED/FAILED) so clients can react to completion without polling. Same ownership rules as every job-scoped route: only the owning User can subscribe. The stream ends after a terminal status; connections respect the gateway's graceful shutdown.

Covers user story 21.

## Acceptance criteria

- [x] Subscribing to a Job streams its status transitions as SSE events and closes after COMPLETED or FAILED
- [x] Subscribing to another user's Job behaves like a nonexistent resource
- [x] A client connecting mid-lifecycle immediately receives the current status, then subsequent transitions
- [x] Graceful shutdown closes streams cleanly
- [x] Integration test consumes the stream end to end with the fake engine

## Blocked by

- [03 - Core tracer bullet](./03-core-tracer-bullet.md)

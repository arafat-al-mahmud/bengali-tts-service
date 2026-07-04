# 09 - Load test with documented results

Issue: [#10](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/10)

## What to build

A k6 load-test script that demonstrates the service's behavior under concurrent multi-user load: a burst of virtual users submitting Jobs, showing 202 acceptances, 429 rate-limit and pending-cap rejections, 503 queue-capacity rejections, and the queue draining afterwards. Results (numbers and a short interpretation) documented in the repo.

Covers user story 38.

## Acceptance criteria

- [x] k6 script runs against the compose stack with the fake engine and a documented one-command invocation
- [x] Scenario exercises all three Backpressure Gates and records the distribution of 202/429/503 responses
- [x] Results are committed: request rates, rejection counts per gate, queue drain behavior, and a short interpretation
- [x] Script is deterministic enough to re-run: seeded users and keys via a setup step

## Blocked by

- [06 - Backpressure Gates](./06-backpressure-gates.md)
- [08 - Observability](./08-observability.md)

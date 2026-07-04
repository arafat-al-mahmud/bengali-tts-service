# 11 - Idempotency Key on submission

Issue: [#12](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/12)

## What to build

Optional Idempotency Key support on Job submission. A client supplies an Idempotency-Key header; re-submitting with the same key and same user returns the original Job (200-style replay with the existing job id) instead of creating a duplicate. Keys are scoped per user, so two users can use the same key value independently.

Covers user story 14.

## Acceptance criteria

- [x] Same user, same key, same payload: second submission returns the original job id without enqueueing a second job
- [x] Same user, same key, different payload: rejected with a machine-readable conflict error
- [x] Different users with the same key value do not collide
- [x] Uniqueness enforced by a database constraint, not application-level checks alone
- [x] Integration tests cover replay, conflict, and cross-user independence

## Blocked by

- [03 - Core tracer bullet](./03-core-tracer-bullet.md)

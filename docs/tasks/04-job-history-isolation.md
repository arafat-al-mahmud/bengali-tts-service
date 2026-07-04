# 04 - Job History and isolation hardening

Issue: [#5](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/5)

## What to build

Job History and isolation hardening. An authenticated User lists their own Jobs, paginated, newest first, including FAILED ones with error codes. Every job-scoped route is verified to behave identically for "not mine" and "does not exist" (404, never 403), so resource ids leak nothing. The composite index backing history pagination (user, created-at descending) is in place and its rationale documented.

Covers user stories 19, 20, 22, 23.

## Acceptance criteria

- [ ] History endpoint returns only the caller's Jobs, newest first, with pagination and a stable page shape
- [ ] Failed Jobs appear in history with machine-readable error codes
- [ ] For every job-scoped route, another user's job id returns a response indistinguishable from a nonexistent id
- [ ] Composite index on (user, created-at desc) exists in a committed migration
- [ ] Integration tests: two users each submit jobs; each sees exactly their own history; cross-user reads fail on every route

## Blocked by

- [03 - Core tracer bullet](./03-core-tracer-bullet.md)

# 01 - Walking skeleton

Issue: [#2](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/2)

## What to build

The walking skeleton: a compose-runnable stack where every service starts, connects, and proves itself healthy, with CI enforcing quality from the first commit. Monorepo with a TypeScript Express gateway and a Python worker (both minimal), Postgres, Redis, and MinIO in docker compose. Prisma initialized with the first migration (the User model is enough to prove the migration path), `migrate deploy` running on gateway startup. Liveness and readiness endpoints on the gateway, with readiness verifying Postgres, Redis, and MinIO connectivity. GitHub Actions running lint, typecheck, and tests for both languages.

## Acceptance criteria

- [ ] `docker compose up` brings up gateway, worker, Postgres, Redis, and MinIO with no manual steps
- [ ] Gateway liveness endpoint returns 200; readiness returns 200 only when Postgres, Redis, and MinIO are all reachable, 503 otherwise
- [ ] Prisma migration applies automatically on startup; a committed SQL migration file exists
- [ ] Worker starts, connects to Redis, and logs readiness (no job handling yet)
- [ ] One Supertest integration test hits the health endpoints against real containers
- [ ] CI runs lint, typecheck, and test jobs for gateway and worker on every push and PR, and is green

## Blocked by

None - can start immediately

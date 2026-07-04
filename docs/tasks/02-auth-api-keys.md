# 02 - Registration and API Key lifecycle

Issue: [#3](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/3)

## What to build

Registration and the full API Key lifecycle. A User registers with email and password (bcrypt-hashed). An authenticated User creates API Keys: the full key (`sk_live_<random>`) is returned exactly once at creation; only a SHA-256 hash and a display prefix are stored. Users can list their keys (prefix, created, last-used) and revoke any. An auth middleware resolves the presented key to a User via constant-time hash comparison and rejects unknown or revoked keys with 401. All error responses use the standard envelope `{error: {code, message, details?}}`.

Covers user stories 1-7 from the PRD.

## Acceptance criteria

- [ ] Registration validates input (zod), rejects duplicate email with a machine-readable error code, and never returns the password hash
- [ ] Key creation returns the full key exactly once; subsequent listings show only prefix and metadata
- [ ] Database stores only the key hash, enforced by a unique index; the raw key appears nowhere in the database or logs
- [ ] Revoked and unknown keys receive 401 with distinct machine-readable codes
- [ ] A user can hold multiple active keys; revoking one leaves the others working
- [ ] Supertest integration tests cover the full lifecycle: register, create key, authenticate, list, revoke, 401 after revocation

## Blocked by

- [01 - Walking skeleton](./01-walking-skeleton.md)

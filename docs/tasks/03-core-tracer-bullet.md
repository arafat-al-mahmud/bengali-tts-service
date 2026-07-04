# 03 - Core tracer bullet: submit to audio download

Issue: [#4](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/4)

## What to build

An authenticated User submits Input Text and ends up downloading a playable WAV, with every layer in between real except inference itself. POST to the TTS endpoint validates input (non-empty, length cap, Bengali-dominant rule), creates a Job row, enqueues to BullMQ, and returns 202 with job id, status URL, and suggested polling interval. The Python worker consumes the job single-flight, synthesizes via the fake TTS Engine (env-selected), uploads the WAV to MinIO, and marks the Job COMPLETED. The status endpoint reports QUEUED/ACTIVE/COMPLETED; the audio endpoint streams the WAV only after verifying the Job belongs to the authenticated User, returning 404 for other users' jobs and a conflict-style response for unfinished ones.

Covers user stories 8-13, 15, 17, 18, and the ownership half of 22.

## Acceptance criteria

- [x] Submission returns 202 with job id and status URL; invalid text (empty, oversized, non-Bengali-dominant) returns 422 with distinct machine-readable codes
- [x] Text with digits, punctuation, and occasional loanwords is accepted; predominantly non-Bengali text is rejected
- [x] Worker consumes via the official BullMQ Python client, processes one job at a time, uploads to MinIO, and transitions the Job row QUEUED, ACTIVE, COMPLETED
- [x] Audio endpoint streams a playable WAV with correct content type for the owner, 404 for any other user, and a conflict response before completion
- [x] Integration tests run the full pipeline against real Postgres, Redis, and MinIO with the fake engine (no BullMQ mocking)
- [x] Worker pytest suite asserts job completion, MinIO object presence, and final database state

## Blocked by

- [02 - Registration and API Key lifecycle](./02-auth-api-keys.md)

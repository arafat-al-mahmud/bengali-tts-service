# 13 - Submission package

Issue: [#14](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/14)

## What to build

The final review and documentation pass. README with: what the service is, architecture diagram, one-command setup, API usage examples (full curl flow from registration to WAV download), configuration reference, trade-off discussion (queueing model, backpressure design, storage choices, scaling paths), database notes (schema rationale, index choices, a sample query plan), and known limitations. Pull request description summarizing the design. Final end-to-end verification of the compose stack and the e2e smoke script, plus a human review of the whole diff.

## Acceptance criteria

- [ ] README covers setup, API usage with runnable examples, configuration, architecture (with diagram), trade-offs, and limitations
- [ ] Fresh-clone test: following the README verbatim on a clean machine yields a working service and a playable WAV
- [ ] E2E smoke script passes against the compose stack
- [ ] PR description summarizes architecture and decision rationale, linking ADRs and task docs
- [ ] Human review of the complete diff before the PR is marked ready

## Blocked by

- Tasks 01 through 08 (all core slices)

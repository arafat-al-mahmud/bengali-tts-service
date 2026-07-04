# Bengali TTS Service

A multi-user API service that turns Bengali text into playable audio using the IndicF5 text-to-speech model. Designed around three constraints: inference is slow and compute-bound, users must be strictly isolated from each other, and the service must stay responsive under concurrent load.

## Language

**User**:
A registered account that owns API Keys and Jobs. Registers with email + password.
_Avoid_: client, account, tenant

**API Key**:
A secret credential issued to a User, displayed exactly once at creation, and presented on every request to identify the caller. A User may hold several and revoke any.
_Avoid_: token, secret, credential

**Job**:
One text-to-speech request through its whole lifecycle: submitted, queued, processed, and finished with either an Audio Result or a failure. Owned by exactly one User.
_Avoid_: task, request, synthesis

**Job Status**:
The lifecycle stage of a Job: `QUEUED`, `ACTIVE`, `COMPLETED`, or `FAILED`. Failed Jobs carry a machine-readable error code and stay visible in Job History.
_Avoid_: state, phase

**Input Text**:
The Bengali-dominant text a Job synthesizes. Valid when non-empty, within the length cap, and at least half its non-whitespace codepoints fall in the Bengali Unicode block - digits, punctuation, and occasional loanwords are allowed.
_Avoid_: prompt, payload, content

**Audio Result**:
The playable WAV file produced by a completed Job. Retrievable only by the Job's owning User.
_Avoid_: output, artifact, file

**Job History**:
A User's own past and pending Jobs, paginated. Never visible to any other User.
_Avoid_: activity, log

**TTS Engine**:
The component that turns Input Text into an Audio Result. Two implementations: the real IndicF5 engine and a fake engine used in tests.
_Avoid_: model, model wrapper, inference service

**Reference Voice**:
The bundled voice sample IndicF5 conditions on to produce speech. This service ships one default Reference Voice; voice selection is out of scope.
_Avoid_: speaker, voice prompt

**Backpressure Gates**:
The three layered admission controls on Job submission: the per-User Rate Limit, the per-User Pending Cap, and the global Queue Capacity. Each rejects with a distinct status code.

**Rate Limit**:
The per-User cap on submission requests per minute. Exceeding it rejects the request; it does not affect Jobs already accepted.

**Pending Cap**:
The maximum number of a User's Jobs allowed in `QUEUED` or `ACTIVE` at once. Fairness gate: one User cannot fill the queue.

**Queue Capacity**:
The global maximum of Jobs waiting to be processed. When full, all submissions are rejected regardless of User.

**Idempotency Key**:
An optional client-supplied header on Job submission. Re-submitting with the same key returns the original Job instead of creating a duplicate.

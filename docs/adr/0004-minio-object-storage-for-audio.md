# MinIO object storage for audio, streamed through the gateway

Generated WAVs are written by the Python worker and served by the Node gateway. A shared Docker volume would force both onto one host - untenable in any real deployment where GPU workers live on separate machines from the API tier. The worker uploads to a MinIO bucket (S3-compatible), the job record stores the object key, and the gateway streams the object to the client only after verifying the job belongs to the authenticated user. Migration to managed S3 is an endpoint/credentials change, zero code.

We deliberately do not use presigned URLs: they would bypass the auth middleware and make URL expiry the isolation mechanism. Ownership-checked streaming through the gateway keeps a single auth gate; presigned URLs remain the documented scale-out option for offloading download bandwidth.

## Alternatives

- **Shared volume** - simplest to run; but it makes horizontal worker scaling physically impossible.
- **Audio bytes in PostgreSQL** - transactional with job state; but large binaries bloat the relational store, slow backups, and offer nothing over object storage here.
- **Redis with TTL** - results lost on restart; large binaries compete with queue memory.

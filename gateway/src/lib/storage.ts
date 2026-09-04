import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Context, Data, Effect, Schedule } from 'effect';
import type { Config } from '../config.js';

export function createS3(config: Config): S3Client {
  return new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: 'us-east-1',
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    // MinIO serves buckets under the path, not as subdomains.
    forcePathStyle: true,
  });
}

/** The name Effect code uses to ask for object storage. */
export class StorageService extends Context.Tag('StorageService')<StorageService, S3Client>() {}

/**
 * Storage did not answer. This is deliberately not one of the refusals in
 * errors.ts: no client request caused it, so it renders as a 500 rather
 * than as something the caller could have avoided.
 */
export class StorageUnavailable extends Data.TaggedError('StorageUnavailable')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/**
 * Object storage in the compose stack can take longer to accept
 * connections than the gateway takes to boot. Waiting through that is
 * worth about fifteen seconds; past that the dependency is genuinely
 * absent and refusing to start is the honest outcome.
 */
export const BUCKET_BOOTSTRAP_RETRY = Schedule.exponential('200 millis').pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(6)),
);

/** Enough to ride out a dropped connection, short enough a client waits. */
export const TRANSIENT_READ_RETRY = Schedule.exponential('50 millis').pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(2)),
);

/**
 * A failure on the way to storage rather than an answer from it: no HTTP
 * status means the request never landed, and 5xx or 429 means storage
 * asked us to come back. A 404 or 403 is a real answer and retrying it
 * would only delay the same result.
 */
export function isTransient(error: StorageUnavailable): boolean {
  const status = (error.cause as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata
    ?.httpStatusCode;
  if (status === undefined) return true;
  return status >= 500 || status === 429;
}

/**
 * Creates the bucket when it is missing, and keeps trying while storage is
 * still coming up. Boot survives a slow dependency instead of racing it.
 */
export function ensureBucket(bucket: string): Effect.Effect<void, StorageUnavailable, StorageService> {
  return Effect.gen(function* () {
    const s3 = yield* StorageService;
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        } catch {
          await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        }
      },
      catch: (cause) => new StorageUnavailable({ operation: 'ensureBucket', cause }),
    });
  }).pipe(Effect.retry(BUCKET_BOOTSTRAP_RETRY));
}

/** Readiness probe: no retry, because a probe that waits is not a probe. */
export function checkBucket(bucket: string): Effect.Effect<void, StorageUnavailable, StorageService> {
  return Effect.gen(function* () {
    const s3 = yield* StorageService;
    yield* Effect.tryPromise({
      try: () => s3.send(new HeadBucketCommand({ Bucket: bucket })),
      catch: (cause) => new StorageUnavailable({ operation: 'checkBucket', cause }),
    });
  });
}

/**
 * Fetching a finished recording. The read is idempotent, so a connection
 * that dropped on the way out is worth retrying; a missing object is not.
 */
export function getAudioObject(
  bucket: string,
  key: string,
): Effect.Effect<GetObjectCommandOutput, StorageUnavailable, StorageService> {
  return Effect.gen(function* () {
    const s3 = yield* StorageService;
    return yield* Effect.tryPromise({
      try: () => s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
      catch: (cause) => new StorageUnavailable({ operation: 'getObject', cause }),
    });
  }).pipe(Effect.retry({ while: isTransient, schedule: TRANSIENT_READ_RETRY }));
}

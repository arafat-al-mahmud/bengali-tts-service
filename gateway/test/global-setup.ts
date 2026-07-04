import { execSync } from 'node:child_process';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    DATABASE_URL: string;
    REDIS_URL: string;
    S3_ENDPOINT: string;
    S3_ACCESS_KEY: string;
    S3_SECRET_KEY: string;
    S3_BUCKET: string;
  }
}

let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let minio: StartedTestContainer;

export async function setup(project: TestProject): Promise<void> {
  [postgres, redis, minio] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
    new GenericContainer('minio/minio:latest')
      .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
      .start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  execSync('npx prisma migrate deploy', {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  project.provide('DATABASE_URL', databaseUrl);
  project.provide('REDIS_URL', `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`);
  project.provide('S3_ENDPOINT', `http://${minio.getHost()}:${minio.getMappedPort(9000)}`);
  project.provide('S3_ACCESS_KEY', 'minioadmin');
  project.provide('S3_SECRET_KEY', 'minioadmin');
  project.provide('S3_BUCKET', 'tts-audio-test');
}

export async function teardown(): Promise<void> {
  await Promise.all([postgres.stop(), redis.stop(), minio.stop()]);
}

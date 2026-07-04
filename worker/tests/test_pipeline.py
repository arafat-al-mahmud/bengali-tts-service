"""Full pipeline test: real BullMQ enqueue, real worker consume, fake engine.

The schema comes from the gateway's committed Prisma migrations, so this
suite also proves those SQL files stand on their own.
"""

import asyncio
import io
import uuid
import wave
from pathlib import Path

import boto3
import psycopg
import pytest
from bullmq import Queue, Worker
from testcontainers.minio import MinioContainer
from testcontainers.postgres import PostgresContainer
from testcontainers.redis import RedisContainer

from worker import db, storage
from worker.engines.fake import FakeEngine
from worker.processor import Processor

MIGRATIONS_DIR = Path(__file__).parents[2] / "gateway" / "prisma" / "migrations"
BENGALI = "আজকের আবহাওয়া খুব সুন্দর এবং আকাশ পরিষ্কার।"
BUCKET = "tts-audio-test"


@pytest.fixture(scope="module")
def postgres_url():
    with PostgresContainer("postgres:16-alpine") as container:
        url = container.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
        with psycopg.connect(url, autocommit=True) as conn:
            for migration in sorted(MIGRATIONS_DIR.glob("*/migration.sql")):
                conn.execute(migration.read_text())
        yield url


@pytest.fixture(scope="module")
def redis_url():
    with RedisContainer("redis:7-alpine") as container:
        host = container.get_container_host_ip()
        port = container.get_exposed_port(6379)
        yield f"redis://{host}:{port}"


@pytest.fixture(scope="module")
def s3():
    with MinioContainer("minio/minio:latest") as container:
        config = container.get_config()
        client = boto3.client(
            "s3",
            endpoint_url=f"http://{config['endpoint']}",
            aws_access_key_id=config["access_key"],
            aws_secret_access_key=config["secret_key"],
            region_name="us-east-1",
        )
        client.create_bucket(Bucket=BUCKET)
        yield client


def seed_job(conn: psycopg.Connection) -> tuple[str, str]:
    user_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO users (id, email, password_hash) VALUES (%s, %s, 'x')",
        (user_id, f"{user_id}@example.com"),
    )
    conn.execute(
        "INSERT INTO jobs (id, user_id, input_text) VALUES (%s, %s, %s)",
        (job_id, user_id, BENGALI),
    )
    return user_id, job_id


async def wait_for_status(conn: psycopg.Connection, job_id: str, timeout: float = 30.0) -> str:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        row = conn.execute("SELECT status FROM jobs WHERE id = %s", (job_id,)).fetchone()
        if row and row[0] in ("COMPLETED", "FAILED"):
            return row[0]
        await asyncio.sleep(0.2)
    raise TimeoutError(f"job {job_id} did not reach a terminal status")


async def test_enqueued_job_completes_end_to_end(postgres_url, redis_url, s3):
    conn = db.connect(postgres_url)
    user_id, job_id = seed_job(conn)

    queue = Queue("tts", {"connection": redis_url})
    await queue.add("synthesize", {"jobId": job_id}, {"jobId": job_id})

    processor = Processor(conn, s3, FakeEngine(), BUCKET)
    worker = Worker("tts", processor.process, {"connection": redis_url, "concurrency": 1})
    try:
        status = await wait_for_status(conn, job_id)
    finally:
        await worker.close()
        await queue.close()

    assert status == "COMPLETED"

    row = conn.execute(
        "SELECT audio_key, started_at, completed_at, error_code FROM jobs WHERE id = %s",
        (job_id,),
    ).fetchone()
    audio_key, started_at, completed_at, error_code = row
    assert audio_key == storage.audio_key(user_id, job_id)
    assert started_at is not None and completed_at is not None
    assert error_code is None

    body = s3.get_object(Bucket=BUCKET, Key=audio_key)["Body"].read()
    with wave.open(io.BytesIO(body)) as wav_file:
        assert wav_file.getnframes() > 0
        assert wav_file.getframerate() > 0
    conn.close()


async def test_redelivered_job_is_not_processed_twice(postgres_url, redis_url, s3):
    conn = db.connect(postgres_url)
    _user_id, job_id = seed_job(conn)

    class CountingEngine(FakeEngine):
        calls = 0

        def synthesize(self, text: str) -> bytes:
            type(self).calls += 1
            return super().synthesize(text)

    engine = CountingEngine()
    processor = Processor(conn, s3, engine, BUCKET)

    queue = Queue("tts", {"connection": redis_url})
    await queue.add("synthesize", {"jobId": job_id}, {"jobId": job_id})
    worker = Worker("tts", processor.process, {"connection": redis_url, "concurrency": 1})
    try:
        await wait_for_status(conn, job_id)
        # Simulate a redelivery of the same job id after completion.
        await queue.add("synthesize", {"jobId": job_id}, {"jobId": f"{job_id}-redelivery"})
        await asyncio.sleep(2)
    finally:
        await worker.close()
        await queue.close()

    assert CountingEngine.calls == 1
    conn.close()

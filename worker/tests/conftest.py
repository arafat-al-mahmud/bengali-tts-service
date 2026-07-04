"""Shared fixtures: real Postgres/Redis/MinIO containers, one set per session.

The schema comes from the gateway's committed Prisma migrations, so these
suites also prove those SQL files stand on their own.
"""

import asyncio
import uuid
from pathlib import Path

import boto3
import psycopg
import pytest
from testcontainers.minio import MinioContainer
from testcontainers.postgres import PostgresContainer
from testcontainers.redis import RedisContainer

MIGRATIONS_DIR = Path(__file__).parents[2] / "gateway" / "prisma" / "migrations"
BENGALI = "আজকের আবহাওয়া খুব সুন্দর এবং আকাশ পরিষ্কার।"
BUCKET = "tts-audio-test"


@pytest.fixture(scope="session")
def postgres_url():
    with PostgresContainer("postgres:16-alpine") as container:
        url = container.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
        with psycopg.connect(url, autocommit=True) as conn:
            for migration in sorted(MIGRATIONS_DIR.glob("*/migration.sql")):
                conn.execute(migration.read_text())
        yield url


@pytest.fixture(scope="session")
def redis_url():
    with RedisContainer("redis:7-alpine") as container:
        host = container.get_container_host_ip()
        port = container.get_exposed_port(6379)
        yield f"redis://{host}:{port}"


@pytest.fixture(scope="session")
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

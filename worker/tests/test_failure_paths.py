"""Failure paths against real BullMQ semantics: timeout, retry, stalled recovery.

No queue mocking anywhere; each test enqueues a real job and lets a real
worker consume it.
"""

import asyncio
import time

from bullmq import Queue, Worker

from conftest import BUCKET, seed_job, wait_for_status
from worker import db
from worker.engines.fake import FakeEngine
from worker.processor import Processor

RETRY_OPTS = {"attempts": 2, "backoff": {"type": "fixed", "delay": 200}}


class CountingEngine(FakeEngine):
    def __init__(self):
        self.calls = 0

    def synthesize(self, text: str) -> bytes:
        self.calls += 1
        return super().synthesize(text)


class SlowEngine(CountingEngine):
    def __init__(self, delay: float):
        super().__init__()
        self._delay = delay

    def synthesize(self, text: str) -> bytes:
        self.calls += 1
        time.sleep(self._delay)
        return FakeEngine.synthesize(self, text)


class FlakyEngine(CountingEngine):
    """Fails on the first call, succeeds afterwards."""

    def synthesize(self, text: str) -> bytes:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("transient: connection to postgres://tts:secret@db failed")
        return FakeEngine.synthesize(self, text)


class AlwaysFailingEngine(CountingEngine):
    def synthesize(self, text: str) -> bytes:
        self.calls += 1
        raise RuntimeError("persistent: /app/src/worker/engines/indicf5.py line 42 exploded")


async def run_job(processor, redis_url, conn, job_id, opts=None, queue_name="tts"):
    queue = Queue(queue_name, {"connection": redis_url})
    await queue.add("synthesize", {"jobId": job_id}, {"jobId": job_id, **(opts or {})})
    worker = Worker(queue_name, processor.process, {"connection": redis_url, "concurrency": 1})
    try:
        status = await wait_for_status(conn, job_id)
        # Leave room for a wrong extra retry to fire before we count calls.
        await asyncio.sleep(1)
    finally:
        await worker.close()
        await queue.close()
    return status


def fetch_error(conn, job_id):
    return conn.execute(
        "SELECT error_code, error_message, completed_at FROM jobs WHERE id = %s",
        (job_id,),
    ).fetchone()


async def test_timeout_lands_failed_with_timeout_code_and_no_retry(postgres_url, redis_url, s3):
    conn = db.connect(postgres_url)
    _user_id, job_id = seed_job(conn)
    engine = SlowEngine(delay=5)
    processor = Processor(conn, s3, engine, BUCKET, timeout_seconds=1)

    status = await run_job(processor, redis_url, conn, job_id, opts=RETRY_OPTS)

    assert status == "FAILED"
    error_code, error_message, completed_at = fetch_error(conn, job_id)
    assert error_code == "TIMEOUT"
    assert completed_at is not None
    # A pathological input must not occupy the worker a second time.
    assert engine.calls == 1
    conn.close()


async def test_transient_failure_succeeds_on_retry(postgres_url, redis_url, s3):
    conn = db.connect(postgres_url)
    user_id, job_id = seed_job(conn)
    engine = FlakyEngine()
    processor = Processor(conn, s3, engine, BUCKET, timeout_seconds=30)

    status = await run_job(processor, redis_url, conn, job_id, opts=RETRY_OPTS)

    assert status == "COMPLETED"
    assert engine.calls == 2
    error_code, _error_message, _ = fetch_error(conn, job_id)
    assert error_code is None
    conn.close()


async def test_persistent_failure_lands_failed_after_exactly_one_retry(postgres_url, redis_url, s3):
    conn = db.connect(postgres_url)
    _user_id, job_id = seed_job(conn)
    engine = AlwaysFailingEngine()
    processor = Processor(conn, s3, engine, BUCKET, timeout_seconds=30)

    status = await run_job(processor, redis_url, conn, job_id, opts=RETRY_OPTS)

    assert status == "FAILED"
    assert engine.calls == 2
    error_code, error_message, _ = fetch_error(conn, job_id)
    assert error_code == "INTERNAL"
    # The exception detail (paths, connection strings) stays in worker logs.
    assert error_message == "Synthesis failed"
    conn.close()


async def wait_for_active(conn, job_id, timeout: float = 15.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        row = conn.execute("SELECT status FROM jobs WHERE id = %s", (job_id,)).fetchone()
        if row and row[0] == "ACTIVE":
            return
        await asyncio.sleep(0.1)
    raise AssertionError("job never went ACTIVE")


async def test_over_stalled_job_lands_failed_in_the_database(postgres_url, redis_url, s3):
    """A job that exceeds the stall limit is failed by BullMQ without the
    processor ever running; the failed-event listener must still record the
    failure so the row does not sit ACTIVE forever."""
    conn = db.connect(postgres_url)
    _user_id, job_id = seed_job(conn)

    slow = SlowEngine(delay=30)
    first = Worker(
        "tts",
        Processor(conn, s3, slow, BUCKET, timeout_seconds=60).process,
        {"connection": redis_url, "lockDuration": 2000, "stalledInterval": 60000},
    )
    queue = Queue("tts", {"connection": redis_url})
    await queue.add("synthesize", {"jobId": job_id}, {"jobId": job_id})
    await wait_for_active(conn, job_id)
    await first.close(force=True)

    # maxStalledCount 0: the single stall above already exceeds the limit,
    # so this worker's stalled check defers the job to failure instead of
    # redelivering it.
    healthy_engine = CountingEngine()
    recovery = Processor(conn, s3, healthy_engine, BUCKET, timeout_seconds=60)
    second = Worker(
        "tts",
        recovery.process,
        {
            "connection": redis_url,
            "lockDuration": 5000,
            "stalledInterval": 500,
            "maxStalledCount": 0,
        },
    )
    second.on("failed", recovery.record_bypassed_failure)
    try:
        status = await wait_for_status(conn, job_id, timeout=30)
    finally:
        await second.close()
        await queue.close()

    assert status == "FAILED"
    error_code, error_message, completed_at = fetch_error(conn, job_id)
    assert error_code == "INTERNAL"
    assert error_message == "Synthesis failed"
    assert completed_at is not None
    # The processor itself never ran for the recovery worker.
    assert healthy_engine.calls == 0
    conn.close()


async def test_killed_worker_job_is_recovered_by_stalled_check(postgres_url, redis_url, s3):
    conn = db.connect(postgres_url)
    _user_id, job_id = seed_job(conn)

    # First worker takes the job, then dies mid-synthesis. Short lock so the
    # abandoned job is visibly stalled quickly; the stalled checker of this
    # worker is pushed out of the picture.
    slow = SlowEngine(delay=30)
    first = Worker(
        "tts",
        Processor(conn, s3, slow, BUCKET, timeout_seconds=60).process,
        {"connection": redis_url, "lockDuration": 2000, "stalledInterval": 60000},
    )
    queue = Queue("tts", {"connection": redis_url})
    await queue.add("synthesize", {"jobId": job_id}, {"jobId": job_id})

    await wait_for_active(conn, job_id)

    # Simulated crash: in-flight processing is cancelled, the lock is never
    # released, and the database row stays ACTIVE.
    await first.close(force=True)

    healthy_engine = CountingEngine()
    second = Worker(
        "tts",
        Processor(conn, s3, healthy_engine, BUCKET, timeout_seconds=60).process,
        {"connection": redis_url, "lockDuration": 5000, "stalledInterval": 500},
    )
    try:
        status = await wait_for_status(conn, job_id, timeout=30)
    finally:
        await second.close()
        await queue.close()

    assert status == "COMPLETED"
    assert healthy_engine.calls == 1
    conn.close()

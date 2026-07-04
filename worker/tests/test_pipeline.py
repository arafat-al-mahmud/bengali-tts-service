"""Full pipeline test: real BullMQ enqueue, real worker consume, fake engine."""

import asyncio
import io
import wave

from bullmq import Queue, Worker

from conftest import BUCKET, seed_job, wait_for_status
from worker import db, storage
from worker.engines.fake import FakeEngine
from worker.processor import Processor


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

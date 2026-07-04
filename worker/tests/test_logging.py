"""Worker log lines are JSON and carry the submission's correlation id."""

import json

from bullmq import Queue, Worker

from conftest import BUCKET, seed_job, wait_for_status
from worker import db
from worker.engines.fake import FakeEngine
from worker.logs import configure_logging
from worker.processor import Processor

CORRELATION_ID = "req-observability-test"


async def test_worker_logs_carry_the_correlation_id(postgres_url, redis_url, s3, capsys):
    configure_logging()
    conn = db.connect(postgres_url)
    _user_id, job_id = seed_job(conn)

    queue = Queue("tts", {"connection": redis_url})
    await queue.add(
        "synthesize",
        {"jobId": job_id, "correlationId": CORRELATION_ID},
        {"jobId": job_id},
    )
    worker = Worker(
        "tts",
        Processor(conn, s3, FakeEngine(), BUCKET).process,
        {"connection": redis_url, "concurrency": 1},
    )
    try:
        status = await wait_for_status(conn, job_id)
    finally:
        await worker.close()
        await queue.close()
    assert status == "COMPLETED"

    lines = [
        json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")
    ]
    assert lines, "worker emitted no JSON log lines"
    matching = [
        line
        for line in lines
        if line.get("correlation_id") == CORRELATION_ID and line.get("job_id") == job_id
    ]
    assert matching, "no log line carried both the job id and the correlation id"
    conn.close()

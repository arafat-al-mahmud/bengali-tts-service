from typing import Any

import psycopg

from worker import db, storage
from worker.engines.base import TTSEngine
from worker.logs import get_logger


class Processor:
    """Handles one BullMQ job: load the row, synthesize, upload, complete.

    Processing is idempotent by job id: a job that already reached a
    terminal state is skipped, so a redelivery (worker crash, stalled-job
    recovery) never synthesizes or uploads twice.
    """

    def __init__(
        self,
        conn: psycopg.Connection,
        s3: Any,
        engine: TTSEngine,
        bucket: str,
    ) -> None:
        self._conn = conn
        self._s3 = s3
        self._engine = engine
        self._bucket = bucket
        self._log = get_logger()

    async def process(self, job: Any, _token: str) -> dict[str, str]:
        job_id = job.data["jobId"]
        log = self._log.bind(job_id=job_id)

        row = db.fetch_job(self._conn, job_id)
        if row is None:
            # Queue entry without a database row: nothing to do, and
            # nothing to retry.
            log.warning("job row not found, skipping")
            return {"skipped": "missing"}
        if row.status in ("COMPLETED", "FAILED"):
            log.info("job already terminal, skipping", status=row.status)
            return {"skipped": row.status.lower()}

        db.mark_active(self._conn, job_id)
        log.info("synthesis started", text_length=len(row.input_text))
        try:
            wav = self._engine.synthesize(row.input_text)
            key = storage.audio_key(row.user_id, job_id)
            storage.upload_wav(self._s3, self._bucket, key, wav)
            db.mark_completed(self._conn, job_id, key)
        except Exception:
            # The client sees a stable code; the exception detail stays in
            # worker logs (BullMQ re-raises for its own bookkeeping).
            db.mark_failed(self._conn, job_id, "INTERNAL", "Synthesis failed")
            log.exception("synthesis failed")
            raise
        log.info("synthesis completed", audio_key=key, wav_bytes=len(wav))
        return {"audioKey": key}

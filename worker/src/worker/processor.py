import asyncio
from typing import Any

import psycopg
from bullmq import UnrecoverableError

from worker import db, storage
from worker.engines.base import TTSEngine
from worker.logs import get_logger


class Processor:
    """Handles one BullMQ job: load the row, synthesize, upload, complete.

    Processing is idempotent by job id: a job that already reached a
    terminal status is skipped, so a redelivery (worker crash, stalled-job
    recovery) never synthesizes or uploads twice.
    """

    def __init__(
        self,
        conn: psycopg.Connection,
        s3: Any,
        engine: TTSEngine,
        bucket: str,
        timeout_seconds: float = 300,
    ) -> None:
        self._conn = conn
        self._s3 = s3
        self._engine = engine
        self._bucket = bucket
        self._timeout_seconds = timeout_seconds
        self._log = get_logger()

    async def process(self, job: Any, _token: str) -> dict[str, str]:
        job_id = job.data["jobId"]
        log = self._log.bind(job_id=job_id)
        # The submission's request id, when present, so one grep follows a
        # job from the gateway through synthesis.
        correlation_id = job.data.get("correlationId")
        if correlation_id:
            log = log.bind(correlation_id=correlation_id)

        row = db.fetch_job(self._conn, job_id)
        if row is None:
            # Queue entry without a database row: nothing to do, and
            # nothing to retry.
            log.warning("job row not found, skipping")
            return {"skipped": "missing"}
        if row.status in db.TERMINAL_STATUSES:
            log.info("job already terminal, skipping", status=row.status)
            return {"skipped": row.status.lower()}

        db.mark_active(self._conn, job_id)
        log.info("synthesis started", text_length=len(row.input_text))
        try:
            # Inference runs in a thread so the event loop stays free to
            # extend the BullMQ job lock; a blocked loop would let another
            # worker steal a long-running job as stalled.
            wav = await asyncio.wait_for(
                asyncio.to_thread(self._engine.synthesize, row.input_text),
                timeout=self._timeout_seconds,
            )
            key = storage.audio_key(row.user_id, job_id)
            storage.upload_wav(self._s3, self._bucket, key, wav)
            db.mark_completed(self._conn, job_id, key)
        except TimeoutError:
            # A pathological input would time out again; failing without
            # retry frees the worker. The synthesis thread itself cannot be
            # killed and is left to finish into the void; its result is
            # never uploaded.
            db.mark_failed(
                self._conn,
                job_id,
                "TIMEOUT",
                f"Synthesis exceeded the {self._timeout_seconds:g} second limit",
            )
            log.error("synthesis timed out", timeout_seconds=self._timeout_seconds)
            raise UnrecoverableError("synthesis timed out") from None
        except Exception:
            # The client sees a stable code and message; the exception
            # detail stays in worker logs.
            final_attempt = job.attemptsMade + 1 >= job.attempts
            if final_attempt:
                db.mark_failed(self._conn, job_id, "INTERNAL", "Synthesis failed")
            else:
                db.mark_queued(self._conn, job_id)
            log.exception("synthesis failed", final_attempt=final_attempt)
            raise
        log.info("synthesis completed", audio_key=key, wav_bytes=len(wav))
        return {"audioKey": key}

    def record_bypassed_failure(self, job: Any, err: Exception) -> None:
        """Failed-event listener for failures that bypass process().

        A job that exceeds BullMQ's stall limit (it repeatedly took a
        worker down with it) is failed during fetch, before the processor
        runs, which would strand the database row in ACTIVE forever. Only
        that deferred path is handled here: ordinary processing failures
        also emit this event, but process() has already recorded those.
        """
        if job is None or not getattr(job, "deferredFailure", None):
            return
        job_id = job.data["jobId"]
        row = db.fetch_job(self._conn, job_id)
        if row is None or row.status in db.TERMINAL_STATUSES:
            return
        db.mark_failed(self._conn, job_id, "INTERNAL", "Synthesis failed")
        self._log.warning("job failed without processing", job_id=job_id, reason=str(err))

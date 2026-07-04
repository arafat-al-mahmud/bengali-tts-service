import asyncio
import signal

from bullmq import Worker
from redis import Redis

from worker import db, storage
from worker.config import load_settings
from worker.engines import create_engine
from worker.logs import configure_logging, get_logger
from worker.processor import Processor


async def run() -> None:
    configure_logging()
    log = get_logger()
    settings = load_settings()

    # Fail fast on unreachable dependencies rather than consuming jobs
    # that cannot complete.
    Redis.from_url(settings.redis_url).ping()
    conn = db.connect(settings.database_url)
    s3 = storage.create_s3(settings)
    engine = create_engine(settings)

    processor = Processor(
        conn, s3, engine, settings.s3_bucket, timeout_seconds=settings.job_timeout_seconds
    )

    worker = Worker(
        settings.queue_name,
        processor.process,
        {
            "connection": settings.redis_url,
            # Inference saturates the compute device; one job at a time per
            # worker process, scale by adding processes.
            "concurrency": 1,
        },
    )
    # Over-stalled jobs are failed by BullMQ without the processor running;
    # this listener keeps the database row in sync for that path.
    worker.on("failed", processor.record_bypassed_failure)
    log.info("worker ready", engine=settings.tts_engine, queue=settings.queue_name)

    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown.set)

    await shutdown.wait()
    log.info("shutting down")
    await worker.close()
    conn.close()
    log.info("shutdown complete")


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()

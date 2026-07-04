import signal
import threading

from redis import Redis

from worker.config import load_settings
from worker.logs import configure_logging, get_logger


def main() -> None:
    configure_logging()
    log = get_logger()
    settings = load_settings()

    redis = Redis.from_url(settings.redis_url)
    redis.ping()
    log.info("worker ready")

    stop = threading.Event()

    def handle_signal(signum: int, _frame: object) -> None:
        log.info("shutting down", signal=signal.Signals(signum).name)
        stop.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # Job consumption arrives with the queue slice; for now the worker only
    # proves it can start, reach Redis, and shut down cleanly.
    stop.wait()


if __name__ == "__main__":
    main()

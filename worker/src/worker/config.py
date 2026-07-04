import os
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    redis_url: str
    database_url: str
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str
    tts_engine: str
    queue_name: str


_REQUIRED = ("REDIS_URL", "DATABASE_URL", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY")


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    missing = [name for name in _REQUIRED if not env.get(name)]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")
    return Settings(
        redis_url=env["REDIS_URL"],
        database_url=env["DATABASE_URL"],
        s3_endpoint=env["S3_ENDPOINT"],
        s3_access_key=env["S3_ACCESS_KEY"],
        s3_secret_key=env["S3_SECRET_KEY"],
        s3_bucket=env.get("S3_BUCKET", "tts-audio"),
        tts_engine=env.get("TTS_ENGINE", "fake"),
        queue_name=env.get("TTS_QUEUE_NAME", "tts"),
    )

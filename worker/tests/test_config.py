import pytest

from worker.config import load_settings

FULL_ENV = {
    "REDIS_URL": "redis://example:6379",
    "DATABASE_URL": "postgresql://user:pass@example:5432/tts",
    "S3_ENDPOINT": "http://example:9000",
    "S3_ACCESS_KEY": "access",
    "S3_SECRET_KEY": "secret",
}


def test_load_settings_reads_required_values() -> None:
    settings = load_settings(FULL_ENV)
    assert settings.redis_url == "redis://example:6379"
    assert settings.database_url == "postgresql://user:pass@example:5432/tts"


def test_load_settings_applies_defaults() -> None:
    settings = load_settings(FULL_ENV)
    assert settings.s3_bucket == "tts-audio"
    assert settings.tts_engine == "fake"
    assert settings.queue_name == "tts"


def test_load_settings_names_every_missing_variable() -> None:
    with pytest.raises(RuntimeError, match="REDIS_URL.*DATABASE_URL"):
        load_settings({"S3_ENDPOINT": "x", "S3_ACCESS_KEY": "x", "S3_SECRET_KEY": "x"})


def test_load_settings_rejects_empty_values() -> None:
    with pytest.raises(RuntimeError, match="REDIS_URL"):
        load_settings({**FULL_ENV, "REDIS_URL": ""})

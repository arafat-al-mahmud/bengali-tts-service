import pytest

from worker.config import load_settings


def test_load_settings_reads_redis_url() -> None:
    settings = load_settings({"REDIS_URL": "redis://example:6379"})
    assert settings.redis_url == "redis://example:6379"


def test_load_settings_rejects_missing_redis_url() -> None:
    with pytest.raises(RuntimeError, match="REDIS_URL"):
        load_settings({})


def test_load_settings_rejects_empty_redis_url() -> None:
    with pytest.raises(RuntimeError, match="REDIS_URL"):
        load_settings({"REDIS_URL": ""})

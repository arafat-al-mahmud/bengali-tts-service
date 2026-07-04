import os
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    redis_url: str


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    redis_url = env.get("REDIS_URL")
    if not redis_url:
        raise RuntimeError("REDIS_URL is required")
    return Settings(redis_url=redis_url)

from worker.config import Settings
from worker.engines.base import TTSEngine
from worker.engines.fake import FakeEngine


def create_engine(settings: Settings) -> TTSEngine:
    if settings.tts_engine == "fake":
        return FakeEngine()
    if settings.tts_engine == "indicf5":
        # Imported lazily: pulls torch and friends, which only the real
        # engine needs.
        from worker.engines.indicf5 import IndicF5Engine

        return IndicF5Engine(device=settings.tts_device)
    raise RuntimeError(f"Unknown TTS_ENGINE: {settings.tts_engine!r}")

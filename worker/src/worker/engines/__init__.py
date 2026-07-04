from worker.config import Settings
from worker.engines.base import TTSEngine
from worker.engines.fake import FakeEngine


def create_engine(settings: Settings) -> TTSEngine:
    if settings.tts_engine == "fake":
        return FakeEngine()
    raise RuntimeError(f"Unknown TTS_ENGINE: {settings.tts_engine!r}")

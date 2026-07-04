from typing import Protocol


class TTSEngine(Protocol):
    """Turns text into a complete WAV file (bytes).

    The seam between the pipeline and inference: the fake implementation
    lets every other layer (queue, storage, status transitions) run in tests
    at full speed, while the real engine slots in behind the same call.
    """

    def synthesize(self, text: str) -> bytes: ...

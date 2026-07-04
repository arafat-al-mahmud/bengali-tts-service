import io
import math
import struct
import time
import wave

_SAMPLE_RATE = 22050
_DURATION_SECONDS = 0.5
_FREQUENCY_HZ = 440.0
_AMPLITUDE = 0.2


class FakeEngine:
    """Instant stand-in for real inference: a short, valid, playable WAV.

    An optional delay simulates real inference latency, which is what makes
    queue backlog and backpressure observable under load tests without
    paying for actual synthesis.
    """

    def __init__(self, delay_seconds: float = 0.0) -> None:
        self._delay_seconds = delay_seconds

    def synthesize(self, text: str) -> bytes:
        if self._delay_seconds > 0:
            time.sleep(self._delay_seconds)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(_SAMPLE_RATE)
            frame_count = int(_SAMPLE_RATE * _DURATION_SECONDS)
            angular_step = 2 * math.pi * _FREQUENCY_HZ / _SAMPLE_RATE
            frames = b"".join(
                struct.pack("<h", int(32767 * _AMPLITUDE * math.sin(angular_step * i)))
                for i in range(frame_count)
            )
            wav.writeframes(frames)
        return buffer.getvalue()

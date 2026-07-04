import io
import math
import struct
import wave

_SAMPLE_RATE = 22050
_DURATION_SECONDS = 0.5
_FREQUENCY_HZ = 440.0
_AMPLITUDE = 0.2


class FakeEngine:
    """Instant stand-in for real inference: a short, valid, playable WAV."""

    def synthesize(self, text: str) -> bytes:
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

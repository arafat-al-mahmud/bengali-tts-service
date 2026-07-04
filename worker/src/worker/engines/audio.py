import io
import wave


def pcm16_wav_bytes(samples, sample_rate: int) -> bytes:
    """Wrap a mono numpy sample array as a 16-bit PCM WAV file.

    Accepts int16 samples as-is; float arrays are treated as [-1, 1] and
    clipped, matching what inference models emit.
    """
    import numpy as np

    array = np.asarray(samples)
    if array.dtype == np.int16:
        pcm = array
    else:
        clipped = np.clip(array.astype(np.float32), -1.0, 1.0)
        pcm = (clipped * 32767.0).astype(np.int16)

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())
    return buffer.getvalue()

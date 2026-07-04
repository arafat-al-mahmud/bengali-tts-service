import io
import wave

import numpy as np

from worker.engines.audio import pcm16_wav_bytes


def parse(data: bytes) -> tuple[wave.Wave_read, bytes]:
    with wave.open(io.BytesIO(data)) as wav_file:
        return wav_file, wav_file.readframes(wav_file.getnframes())


def test_float_samples_become_valid_pcm16_wav() -> None:
    samples = np.array([0.0, 0.5, -0.5, 1.0, -1.0], dtype=np.float32)
    wav_file, frames = parse(pcm16_wav_bytes(samples, 24000))
    assert wav_file.getframerate() == 24000
    assert wav_file.getnchannels() == 1
    assert wav_file.getsampwidth() == 2
    decoded = np.frombuffer(frames, dtype=np.int16)
    assert decoded[0] == 0
    assert decoded[3] == 32767
    assert decoded[4] == -32767


def test_out_of_range_floats_are_clipped_not_wrapped() -> None:
    samples = np.array([2.0, -2.0], dtype=np.float32)
    _, frames = parse(pcm16_wav_bytes(samples, 24000))
    decoded = np.frombuffer(frames, dtype=np.int16)
    assert decoded[0] == 32767
    assert decoded[1] == -32767


def test_int16_samples_pass_through_unchanged() -> None:
    samples = np.array([123, -456, 32767], dtype=np.int16)
    _, frames = parse(pcm16_wav_bytes(samples, 22050))
    assert np.array_equal(np.frombuffer(frames, dtype=np.int16), samples)

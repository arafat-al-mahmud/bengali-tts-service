# 05 - Real IndicF5 engine

Issue: [#6](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/6)

## What to build

The real TTS Engine: IndicF5 behind the same engine interface as the fake. Model weights download on first start into a cached volume; the bundled Reference Voice ships with the worker; device selection defaults to CPU, uses MPS where available, and honors a GPU env flag. Setup documentation covers model size, first-start download time, and expected CPU inference latency. The engine choice remains env-selected so tests keep using the fake.

Makes user story 17 real.

## Acceptance criteria

- [x] With the real engine enabled, submitting Bengali text produces an intelligible Bengali WAV end to end through the full pipeline
- [x] Model weights are cached in a volume; second start does not re-download
- [x] Device selection (CPU/MPS/GPU flag) is env-driven and logged at startup
- [x] Bundled Reference Voice is committed (or fetched deterministically) with its licensing noted
- [x] CI remains green and fast: no CI job downloads model weights
- [x] Setup docs state weight size, download path, and realistic latency expectations per device

## Blocked by

- [03 - Core tracer bullet](./03-core-tracer-bullet.md)

# Running the real IndicF5 engine

By default the stack runs with `TTS_ENGINE=fake`, which produces valid
placeholder WAVs instantly and exercises every part of the pipeline except
inference itself. This page covers switching the worker to real IndicF5
synthesis.

## Prerequisites

1. **Hugging Face access.** [ai4bharat/IndicF5](https://huggingface.co/ai4bharat/IndicF5)
   is a gated model: open the model page, accept the access terms, and create
   a read-scoped access token at <https://huggingface.co/settings/tokens>.
2. **Disk.** The first start downloads roughly 2 GB of model weights into the
   `model-cache` docker volume. Later starts reuse the cache and skip the
   download entirely.

## Start

```bash
TTS_ENGINE=indicf5 HF_TOKEN=hf_your_token docker compose up --build -d
```

Watch the worker come up (the model load logs the selected device):

```bash
docker compose logs -f worker
```

The worker downloads weights, loads the model, and only then starts
consuming jobs, so a submission made during startup simply waits in the
queue.

## Device selection

`TTS_DEVICE` controls placement:

| Value  | Behavior                                                        |
| ------ | --------------------------------------------------------------- |
| `auto` | CUDA if available, else MPS, else CPU (default)                 |
| `cuda` | NVIDIA GPU (production-like latency)                            |
| `mps`  | Apple Silicon GPU; requires running the worker natively (next section) |
| `cpu`  | Works everywhere                                                 |

Docker containers cannot reach Apple's MPS backend, so `auto` inside
compose resolves to CPU on a Mac. That is expected and intentional for this
demo: measured on an Apple Silicon laptop running compose, a two-sentence
input takes about 3.5 minutes of CPU inference to produce ~5 seconds of
speech. The slowness is what makes the queue, single-flight worker, and
backpressure behavior easy to observe. With `cuda` on a GPU host the same
stack answers in seconds; scaling is a matter of adding worker replicas.

## Native worker on Apple Silicon (MPS) or a host GPU

Docker cannot pass Apple's GPU into a Linux container, so to use an
M-series chip's compute (or a CUDA GPU without the NVIDIA container
toolkit) the worker runs natively on the host while Postgres, Redis,
MinIO, and the gateway stay in compose. An overlay file publishes the
infrastructure ports for it:

```bash
# 1. Infrastructure + gateway in compose, no containerized worker.
docker compose -f docker-compose.yml -f docker-compose.native-worker.yml \
  up -d --build --scale worker=0

# 2. The worker as a host process (Python 3.11+).
cd worker
python3 -m venv .venv-native && source .venv-native/bin/activate
pip install -e '.[indicf5]'

# 3. Point it at the published ports and run.
export DATABASE_URL=postgresql://tts:tts@localhost:55432/tts
export REDIS_URL=redis://localhost:56379
export S3_ENDPOINT=http://localhost:59000
export S3_ACCESS_KEY=minioadmin S3_SECRET_KEY=minioadmin
export TTS_ENGINE=indicf5 HF_TOKEN=hf_your_token
python -m worker.main
```

The worker logs the resolved device at startup; on an M-series Mac,
`TTS_DEVICE=auto` picks `mps`. Model weights land in the default
Hugging Face cache (`~/.cache/huggingface`) instead of the docker
volume. The API is unchanged: clients still talk to the gateway on
port 3000, and `./scripts/e2e-smoke.sh` passes identically. Stop the
native worker with Ctrl-C; jobs submitted while no worker runs simply
wait in the queue.

The host ports (55432, 56379, 59000) are non-default on purpose so
they cannot collide with a Postgres or Redis already installed on the
machine.

## Reference voice

IndicF5 is a voice-cloning model: it needs a short reference audio clip and
its transcript alongside the input text. The worker fetches a prompt shipped
in the model's own repository (`prompts/PAN_F_HAPPY_00001.wav`, MIT-licensed
along with the repository) at first start and caches it next to the weights.
The transcript is taken verbatim from the model card's usage example.
Cross-lingual cloning is a supported property of the model, so the Bengali
input text synthesizes as Bengali speech in that reference voice.

## Notes

- Output is 24 kHz mono 16-bit PCM WAV.
- A committed sample of real output lives at
  [docs/samples/bengali-sample.wav](samples/bengali-sample.wav), produced by
  this stack on CPU (3m13s of inference for 5.3 s of speech, consistent with
  the latency figures above).
- CI never installs torch or downloads weights; the real engine is covered
  by the same pipeline tests through the fake engine, plus manual
  verification documented in the pull request.

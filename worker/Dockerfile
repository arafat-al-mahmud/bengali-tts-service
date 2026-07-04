FROM python:3.11-slim
WORKDIR /app

# git: pip installs the IndicF5 package from GitHub.
# libsndfile1, ffmpeg: audio backends for librosa/soundfile at inference.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Real-inference dependencies (torch and friends) as their own layer:
# they change rarely and dwarf the application, so code edits must not
# re-download them. Mirrors the [indicf5] extra in pyproject.toml.
# transformers stays <4.50 per the IndicF5 requirements: newer versions
# initialize models on the meta device, which breaks the remote code's
# in-constructor vocoder load. The GitHub package itself leaves it unpinned.
RUN pip install --no-cache-dir \
    "f5_tts @ git+https://github.com/AI4Bharat/IndicF5.git" \
    "transformers<4.50" \
    "torchcodec" \
    "huggingface_hub>=0.23"

COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# Model weights land here at first start; compose mounts a volume over it.
ENV HF_HOME=/models
CMD ["python", "-m", "worker.main"]

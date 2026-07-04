# Node/TS gateway + Python inference worker as separate services

IndicF5 is a Python/PyTorch model, while the API tier is Node.js/TypeScript - and inference is CPU/GPU-bound work that must never run inside the Node event loop. We split the system into an Express + TypeScript gateway (auth, validation, rate limiting, job API) and a standalone Python worker that consumes jobs from a queue and runs the model. The process boundary lets workers scale horizontally on GPU hosts independently of the API tier, and a worker crash mid-inference cannot take down the API.

## Alternatives

- **Pure Python (FastAPI)** - one language, one service; but the API tier's concerns (auth, rate limiting, streaming responses, high connection counts) are well served by Node's I/O model, and coupling them to the inference runtime forces the whole service to scale as one unit.
- **Node spawning Python subprocesses** - couples inference lifecycle to the API process, no horizontal worker scaling, poor failure isolation.

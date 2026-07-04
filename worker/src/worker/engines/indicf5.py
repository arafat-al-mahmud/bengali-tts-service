from worker.engines.audio import pcm16_wav_bytes
from worker.logs import get_logger

_REPO_ID = "ai4bharat/IndicF5"
_OUTPUT_SAMPLE_RATE = 24000

# Reference voice: a prompt shipped in the model's own repository, with its
# transcript taken verbatim from the model card's usage example. IndicF5 is
# a polyglot voice-cloning model, so a non-Bengali reference voice still
# produces Bengali speech for Bengali input text.
_REF_AUDIO_FILE = "prompts/PAN_F_HAPPY_00001.wav"
_REF_TEXT = "ਭਹੰਪੀ ਵਿੱਚ ਸਮਾਰਕਾਂ ਦੇ ਭਵਨ ਨਿਰਮਾਣ ਕਲਾ ਦੇ ਵੇਰਵੇ ਗੁੰਝਲਦਾਰ ਅਤੇ ਹੈਰਾਨ ਕਰਨ ਵਾਲੇ ਹਨ, ਜੋ ਮੈਨੂੰ ਖੁਸ਼ ਕਰਦੇ  ਹਨ।"


def resolve_device(requested: str) -> str:
    import torch

    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class IndicF5Engine:
    """Real inference behind the same seam as the fake engine.

    Loading happens in the constructor so a worker fails fast at startup
    (missing HF access, no disk space) instead of failing every job. The
    model repository is gated: it requires accepting the terms on
    huggingface.co and an HF_TOKEN with read access.
    """

    def __init__(self, device: str = "auto") -> None:
        # Heavy imports live here so the fake engine never pays for them.
        from huggingface_hub import hf_hub_download
        from transformers import AutoModel

        log = get_logger()
        self._ref_audio_path = hf_hub_download(_REPO_ID, _REF_AUDIO_FILE)
        self._model = AutoModel.from_pretrained(_REPO_ID, trust_remote_code=True)
        self._device = resolve_device(device)
        try:
            self._model = self._model.to(self._device)
        except (RuntimeError, AttributeError, NotImplementedError):
            # The remote-code wrapper manages device placement itself on
            # some versions; requested placement then stays best-effort.
            log.warning("could not move model explicitly", requested_device=self._device)
        log.info(
            "indicf5 engine ready",
            device=self._device,
            reference_voice=_REF_AUDIO_FILE,
        )

    def synthesize(self, text: str) -> bytes:
        import numpy as np

        audio = self._model(text, ref_audio_path=self._ref_audio_path, ref_text=_REF_TEXT)
        samples = np.asarray(audio)
        if samples.dtype == np.int16:
            samples = samples.astype(np.float32) / 32768.0
        return pcm16_wav_bytes(samples, _OUTPUT_SAMPLE_RATE)

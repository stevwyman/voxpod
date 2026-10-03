"""Local LuxTTS voice profiles. Weights are loaded from the image cache."""

from __future__ import annotations

import io
import logging
import os
import tempfile
import threading
from pathlib import Path

import librosa
import soundfile as sf
import torch

import store
from store import VoiceError

log = logging.getLogger("voxpod")

SAMPLE_RATE = 48000
MAX_TEXT = 500
REF_SECONDS = 10
LANGUAGES = {"en": "English", "zh": "Chinese"}


class SpeechEngine:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._tts = None
        self.ready = False
        self.error: str | None = None
        self.sample_language = "en"

    def load(self) -> None:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_DATASETS_OFFLINE"] = "1"
        threads = int(os.environ.get("VOXPOD_THREADS", "2"))
        log.info("loading speech model on CPU (%s threads)", threads)
        from zipvoice.luxvoice import LuxTTS

        self._tts = LuxTTS("YatharthS/LuxTTS", device="cpu", threads=threads)
        raw = self._tts.transcriber

        def transcribe(audio, **kwargs):
            generate_kwargs = dict(kwargs.pop("generate_kwargs", None) or {})
            # Skip auto-detect. A wrong language here wrecks the voice profile.
            generate_kwargs["language"] = self.sample_language
            generate_kwargs["task"] = "transcribe"
            return raw(audio, generate_kwargs=generate_kwargs, **kwargs)

        self._tts.transcriber = transcribe
        self.ready = True
        log.info("speech model ready")

    def add_voice(self, name: str, audio: bytes, filename: str | None, language: str) -> dict:
        self._require_ready()
        cleaned = store.normalize_name(name)
        if language not in LANGUAGES:
            raise VoiceError("Choose English or Chinese for the sample.")
        voice_id = store.new_id()
        suffix = store.suffix_for(filename)
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(audio)
            upload_path = Path(handle.name)
        try:
            sample, duration = store.write_sample(upload_path, voice_id)
            try:
                self.sample_language = language
                transcript = self._transcribe(sample)
                if len(transcript) < 2:
                    raise VoiceError(
                        "No speech was heard in that recording. Speak the sample line clearly and try again."
                    )
                prompt = self._encode(sample)
                torch.save(prompt, store.prompt_path(voice_id))
                meta = store.write_meta(voice_id, cleaned, duration, transcript, language)
                log.info("saved voice %s (%ss)", voice_id, duration)
                return meta
            except Exception:
                if store.voice_dir(voice_id).is_dir():
                    store.delete_voice(voice_id)
                raise
        finally:
            upload_path.unlink(missing_ok=True)

    def speak(self, voice_id: str, text: str, speed: float) -> bytes:
        self._require_ready()
        meta = store.get_voice(voice_id)
        if not meta.get("ready"):
            raise VoiceError("That voice has no profile yet. Record it again.", status=409)
        spoken = _clean_text(text)
        if not 0.6 <= speed <= 1.2:
            raise VoiceError("Speed must be between 0.6 and 1.2.")
        prompt = torch.load(store.prompt_path(voice_id), map_location="cpu", weights_only=False)
        ordered = {
            "prompt_tokens": prompt["prompt_tokens"],
            "prompt_features_lens": prompt["prompt_features_lens"],
            "prompt_features": prompt["prompt_features"],
            "prompt_rms": prompt["prompt_rms"],
        }
        wav = self._render(spoken, ordered, speed)
        audio = wav.detach().cpu().numpy().squeeze()
        buffer = io.BytesIO()
        sf.write(buffer, audio, SAMPLE_RATE, format="WAV")
        log.info("spoke %s chars with voice %s", len(spoken), voice_id)
        return buffer.getvalue()

    def _render(self, spoken: str, ordered: dict, speed: float):
        # The model multiplies speed by 1.3. A fast setting can be too short for the vocoder.
        attempts = [speed]
        if speed > 0.7:
            attempts.append(0.7)
        last_error: Exception | None = None
        for attempt in attempts:
            try:
                with self._lock:
                    return self._tts.generate_speech(
                        spoken,
                        ordered,
                        num_steps=4,
                        t_shift=0.5,
                        speed=attempt,
                    )
            except RuntimeError as exc:
                last_error = exc
                if "Kernel size" not in str(exc):
                    raise
        log.warning("speech too short: %s", last_error)
        raise VoiceError("That phrase came out too short to play. Add another sentence.")

    def _require_ready(self) -> None:
        if self.error:
            raise VoiceError(f"The speech model failed to load: {self.error}", status=500)
        if not self.ready:
            raise VoiceError("The speech model is still loading.", status=503)

    def _transcribe(self, sample: Path) -> str:
        audio, _sr = librosa.load(str(sample), sr=16000, duration=REF_SECONDS)
        with self._lock:
            result = self._tts.transcriber(audio)
        text = (result.get("text") or "").strip()
        log.info("sample transcript: %s", text)
        return text

    def _encode(self, sample: Path):
        with self._lock:
            return self._tts.encode_prompt(str(sample), duration=REF_SECONDS, rms=0.01)


def _clean_text(text: str) -> str:
    spoken = " ".join(text.split())
    if not spoken:
        raise VoiceError("Enter some text to speak.")
    if len(spoken) > MAX_TEXT:
        raise VoiceError(f"Keep the text to {MAX_TEXT} characters or fewer.")
    return spoken

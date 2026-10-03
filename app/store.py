"""Voice profiles stored on the local volume."""

from __future__ import annotations

import json
import os
import re
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

import soundfile as sf

DATA_DIR = Path(os.environ.get("VOXPOD_DATA", "/data"))
VOICES_DIR = DATA_DIR / "voices"
MIN_SECONDS = 3.0
MAX_SECONDS = 20.0
MAX_NAME = 60
ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
ALLOWED_SUFFIXES = {".webm", ".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".flac", ".aac", ".aiff", ".aif"}


class VoiceError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def normalize_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned:
        raise VoiceError("Give the voice a name.")
    if len(cleaned) > MAX_NAME:
        raise VoiceError(f"Use a name of {MAX_NAME} characters or fewer.")
    return cleaned


def voice_dir(voice_id: str) -> Path:
    if not ID_RE.match(voice_id):
        raise VoiceError("Unknown voice.", status=404)
    return VOICES_DIR / voice_id


def meta_path(voice_id: str) -> Path:
    return voice_dir(voice_id) / "meta.json"


def sample_path(voice_id: str) -> Path:
    return voice_dir(voice_id) / "sample.wav"


def prompt_path(voice_id: str) -> Path:
    return voice_dir(voice_id) / "prompt.pt"


def _read_meta(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    data["ready"] = prompt_path(data["id"]).is_file()
    return data


def list_voices() -> list[dict]:
    if not VOICES_DIR.is_dir():
        return []
    voices = []
    for entry in VOICES_DIR.iterdir():
        meta = entry / "meta.json"
        if meta.is_file():
            voices.append(_read_meta(meta))
    voices.sort(key=lambda item: item.get("created", ""), reverse=True)
    return voices


def get_voice(voice_id: str) -> dict:
    path = meta_path(voice_id)
    if not path.is_file():
        raise VoiceError("Unknown voice.", status=404)
    return _read_meta(path)


def delete_voice(voice_id: str) -> None:
    folder = voice_dir(voice_id)
    if not folder.is_dir():
        raise VoiceError("Unknown voice.", status=404)
    for child in folder.iterdir():
        child.unlink()
    folder.rmdir()


def suffix_for(filename: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix in ALLOWED_SUFFIXES:
        return suffix
    return ".webm"


def write_sample(upload_path: Path, voice_id: str) -> tuple[Path, float]:
    """Convert an upload to a mono 24 kHz wav, trimmed to MAX_SECONDS."""
    folder = voice_dir(voice_id)
    folder.mkdir(parents=True, exist_ok=False)
    dest = sample_path(voice_id)
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(upload_path),
            "-ac",
            "1",
            "-ar",
            "24000",
            "-t",
            str(int(MAX_SECONDS)),
            str(dest),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not dest.is_file():
        delete_voice(voice_id)
        raise VoiceError("Could not read that recording. Try again, or upload a wav file.")

    info = sf.info(str(dest))
    duration = info.frames / float(info.samplerate)
    if duration < MIN_SECONDS:
        delete_voice(voice_id)
        raise VoiceError("Record at least 3 seconds of speech.")

    audio, _sr = sf.read(str(dest), always_2d=False)
    peak = float(abs(audio).max()) if getattr(audio, "size", 0) else 0.0
    if peak < 0.01:
        delete_voice(voice_id)
        raise VoiceError("That recording is silent. Check the microphone and try again.")
    return dest, round(duration, 2)


def write_meta(voice_id: str, name: str, duration: float, transcript: str, language: str) -> dict:
    meta = {
        "id": voice_id,
        "name": name,
        "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "duration_sec": duration,
        "transcript": transcript,
        "language": language,
    }
    path = meta_path(voice_id)
    path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    meta["ready"] = prompt_path(voice_id).is_file()
    return meta


def new_id() -> str:
    return str(uuid.uuid4())

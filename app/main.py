"""Local web app: record a voice, then read typed text in that voice."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from pathlib import Path

def _prepare_runtime() -> None:
    """Create the writable directories a non-root, read-only container needs."""
    for key, default in (
        ("NUMBA_CACHE_DIR", "/tmp/numba-cache"),
        ("XDG_CACHE_HOME", "/tmp/cache"),
        ("MPLCONFIGDIR", "/tmp/matplotlib"),
    ):
        path = Path(os.environ.setdefault(key, default))
        path.mkdir(parents=True, exist_ok=True)
    data = Path(os.environ.get("VOXPOD_DATA", "/data"))
    (data / "voices").mkdir(parents=True, exist_ok=True)


_prepare_runtime()

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import engine as engine_module
import store
from store import VoiceError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("voxpod")

MAX_UPLOAD = 15 * 1024 * 1024
STATIC_DIR = Path(__file__).resolve().parent / "static"

speech = engine_module.SpeechEngine()
app = FastAPI(title="Voxpod", docs_url=None, redoc_url=None)


@app.on_event("startup")
def _startup() -> None:
    def _load() -> None:
        try:
            speech.load()
        except Exception as exc:
            speech.error = str(exc)
            log.exception("model load failed")

    threading.Thread(target=_load, name="model-load", daemon=True).start()


@app.get("/api/status")
def status() -> dict:
    return {"ready": speech.ready, "error": speech.error}


@app.get("/api/voices")
def voices() -> dict:
    return {"voices": store.list_voices()}


@app.post("/api/voices")
async def create_voice(
    name: str = Form(...),
    audio: UploadFile = File(...),
    language: str = Form("en"),
) -> dict:
    payload = await audio.read()
    if not payload:
        raise VoiceError("The recording was empty.")
    if len(payload) > MAX_UPLOAD:
        raise VoiceError("That file is larger than 15 MB.", status=413)
    return await asyncio.to_thread(speech.add_voice, name, payload, audio.filename, language)


@app.get("/api/voices/{voice_id}/sample")
def voice_sample(voice_id: str) -> FileResponse:
    store.get_voice(voice_id)
    path = store.sample_path(voice_id)
    if not path.is_file():
        raise VoiceError("That voice has no recording.", status=404)
    return FileResponse(path, media_type="audio/wav")


@app.delete("/api/voices/{voice_id}")
def remove_voice(voice_id: str) -> dict:
    store.delete_voice(voice_id)
    return {"ok": True}


@app.post("/api/speak")
async def speak(body: dict) -> Response:
    voice_id = str(body.get("voice_id") or "")
    text = str(body.get("text") or "")
    try:
        speed = float(body.get("speed") or 1.0)
    except (TypeError, ValueError):
        raise VoiceError("Speed must be a number.")
    wav = await asyncio.to_thread(speech.speak, voice_id, text, speed)
    return Response(content=wav, media_type="audio/wav")


@app.exception_handler(VoiceError)
def _voice_error(_request, exc: VoiceError) -> JSONResponse:
    return JSONResponse({"detail": exc.message}, status_code=exc.status)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="assets")

"""Download speech models into the image so runtime can stay offline."""

from huggingface_hub import snapshot_download

snapshot_download("YatharthS/LuxTTS")
snapshot_download("openai/whisper-tiny")
print("models cached")

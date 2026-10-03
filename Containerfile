# Build needs a network once, to fetch packages and model weights.
# The running container does not fetch models. See scripts/entrypoint.sh.
FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=180 \
    HF_HOME=/opt/hf \
    HUGGINGFACE_HUB_CACHE=/opt/hf/hub \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TOKENIZERS_PARALLELISM=false \
    PYTHONPATH=/opt/LuxTTS \
    VOXPOD_DATA=/data \
    VOXPOD_THREADS=2

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        git \
        iptables \
        libgomp1 \
        libsndfile1 \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

ARG LUXXTTS_REF=28ae6a61151684fffc9d1a7aa15eafa02286fe0b
RUN git clone https://github.com/ysharma3501/LuxTTS.git /opt/LuxTTS \
    && git -C /opt/LuxTTS checkout "${LUXXTTS_REF}"

COPY requirements.txt /tmp/requirements.txt
# CPU wheels only. The default PyPI torch build for this architecture pulls CUDA libraries.
RUN pip install --no-cache-dir --retries 10 \
        'torch==2.6.0+cpu' 'torchaudio==2.6.0' \
        --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir --retries 10 -r /tmp/requirements.txt \
    && python -c "import torch; assert 'cpu' in torch.__version__, torch.__version__; print('torch', torch.__version__)"

COPY scripts/prefetch_models.py /tmp/prefetch_models.py
RUN python /tmp/prefetch_models.py && rm /tmp/prefetch_models.py

# Imported by LuxTTS at load time, and not pulled in by the slimmer requirements file.
RUN pip install --no-cache-dir --retries 10 tensorboard pydub \
    && python -c "from zipvoice.luxvoice import LuxTTS"

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1

RUN useradd --create-home --home-dir /home/voxpod --shell /bin/sh --uid 1000 voxpod \
    && mkdir -p /data /tmp/numba-cache \
    && chown voxpod:voxpod /data /tmp/numba-cache \
    && chmod -R a+rX /opt/hf /opt/LuxTTS

COPY app /opt/voxpod
COPY scripts/entrypoint.sh /opt/voxpod/entrypoint.sh
COPY NOTICE /opt/voxpod/NOTICE
RUN chmod 755 /opt/voxpod/entrypoint.sh

WORKDIR /opt/voxpod
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/status', timeout=4)"

ENTRYPOINT ["/opt/voxpod/entrypoint.sh"]
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--app-dir", "/opt/voxpod"]

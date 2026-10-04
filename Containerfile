# Red Hat Hardened Images, Python 3.11.
# The builder has a shell and dnf. The runtime image does not: no shell,
# no package manager, and the process is user 65532 from the first instruction.
# Model weights are copied into the runtime image. Voice profiles stay on /data.
FROM registry.access.redhat.com/hi/python:3.11-builder AS builder

USER root

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=180 \
    HF_HOME=/opt/hf \
    HUGGINGFACE_HUB_CACHE=/opt/hf/hub \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TOKENIZERS_PARALLELISM=false \
    PYTHONPATH=/opt/LuxTTS \
    LD_LIBRARY_PATH=/opt/libsndfile/lib

RUN dnf install -y --setopt=install_weak_deps=False \
        cmake \
        gcc \
        gcc-c++ \
        git \
        gzip \
        make \
        tar \
        xz \
    && dnf clean all

# Hummingbird has no ffmpeg package. This is a static GPL build, used only
# to turn a browser recording into wav. See NOTICE.
ARG TARGETARCH
RUN mkdir -p /opt/voxpod/bin /tmp/ffmpeg-src \
    && arch="${TARGETARCH:-$(uname -m)}" \
    && case "${arch}" in \
         amd64|x86_64) ff_arch=amd64 ;; \
         arm64|aarch64) ff_arch=arm64 ;; \
         *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
       esac \
    && python3.11 -c "import urllib.request; urllib.request.urlretrieve('https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ff_arch}-static.tar.xz', '/tmp/ffmpeg.tar.xz')" \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg-src \
    && cp /tmp/ffmpeg-src/*/ffmpeg /opt/voxpod/bin/ffmpeg \
    && chmod 755 /opt/voxpod/bin/ffmpeg \
    && /opt/voxpod/bin/ffmpeg -version \
    && rm -rf /tmp/ffmpeg-src /tmp/ffmpeg.tar.xz

# Wav support only. The app converts every sample to wav before soundfile reads it.
ARG LIBSNDFILE_VERSION=1.2.2
RUN python3.11 -c "import urllib.request; urllib.request.urlretrieve('https://github.com/libsndfile/libsndfile/releases/download/${LIBSNDFILE_VERSION}/libsndfile-${LIBSNDFILE_VERSION}.tar.xz', '/tmp/libsndfile.tar.xz')" \
    && mkdir -p /tmp/libsndfile-src \
    && tar -xJf /tmp/libsndfile.tar.xz -C /tmp/libsndfile-src --strip-components=1 \
    && cmake -S /tmp/libsndfile-src -B /tmp/libsndfile-build \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
        -DCMAKE_INSTALL_PREFIX=/opt/libsndfile \
        -DCMAKE_INSTALL_LIBDIR=lib \
        -DBUILD_SHARED_LIBS=ON \
        -DENABLE_EXTERNAL_LIBS=OFF \
        -DENABLE_MPEG=OFF \
        -DBUILD_PROGRAMS=OFF \
        -DBUILD_EXAMPLES=OFF \
        -DBUILD_TESTING=OFF \
    && cmake --build /tmp/libsndfile-build --parallel \
    && cmake --install /tmp/libsndfile-build \
    && rm -rf /tmp/libsndfile-src /tmp/libsndfile-build /tmp/libsndfile.tar.xz

ARG LUXXTTS_REF=28ae6a61151684fffc9d1a7aa15eafa02286fe0b
RUN git clone https://github.com/ysharma3501/LuxTTS.git /opt/LuxTTS \
    && git -C /opt/LuxTTS checkout "${LUXXTTS_REF}" \
    && rm -rf /opt/LuxTTS/.git

COPY requirements.txt /tmp/requirements.txt
# CPU wheels only. The default PyPI torch build for this architecture pulls CUDA libraries.
RUN pip install --no-cache-dir --retries 10 \
        'torch==2.6.0+cpu' 'torchaudio==2.6.0' \
        --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir --retries 10 -r /tmp/requirements.txt \
    && python3.11 -c "import torch; assert 'cpu' in torch.__version__, torch.__version__; print('torch', torch.__version__)"

COPY scripts/prefetch_models.py /tmp/prefetch_models.py
RUN python3.11 /tmp/prefetch_models.py \
    && rm /tmp/prefetch_models.py \
    && mkdir -p /opt/hf/hub/.locks \
    && python3.11 -c "import soundfile; from zipvoice.luxvoice import LuxTTS; print('libsndfile', soundfile.__libsndfile_version__)" \
    && chmod -R a+rX /opt/hf /opt/LuxTTS /opt/libsndfile /opt/voxpod /usr/local/lib/python3.11/site-packages \
    && chmod 1777 /opt/hf/hub/.locks

FROM registry.access.redhat.com/hi/python:3.11

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/opt/hf \
    HUGGINGFACE_HUB_CACHE=/opt/hf/hub \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1 \
    TOKENIZERS_PARALLELISM=false \
    PYTHONPATH=/opt/LuxTTS:/usr/local/lib64/python3.11/site-packages \
    LD_LIBRARY_PATH=/opt/libsndfile/lib \
    PATH=/opt/voxpod/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/tmp \
    TMPDIR=/tmp \
    NUMBA_CACHE_DIR=/tmp/numba-cache \
    XDG_CACHE_HOME=/tmp/cache \
    MPLCONFIGDIR=/tmp/matplotlib \
    VOXPOD_DATA=/data \
    VOXPOD_THREADS=2

USER root
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/lib64/python3.11/site-packages /usr/local/lib64/python3.11/site-packages
COPY --from=builder /opt/hf /opt/hf
COPY --from=builder /opt/LuxTTS /opt/LuxTTS
COPY --from=builder /opt/libsndfile /opt/libsndfile
COPY --from=builder /opt/voxpod/bin/ffmpeg /opt/voxpod/bin/ffmpeg
COPY app /opt/voxpod
COPY NOTICE /opt/voxpod/NOTICE

# Numeric user from the base image. It has no shell and no home directory.
USER 65532
WORKDIR /opt/voxpod
EXPOSE 8085
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["python3.11", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8085/api/status', timeout=4)"]

CMD ["python3.11", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8085", "--app-dir", "/opt/voxpod"]

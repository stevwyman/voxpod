#!/bin/sh
set -eu

export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export HF_DATASETS_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1
export TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1
export TOKENIZERS_PARALLELISM=false
export NUMBA_CACHE_DIR="${NUMBA_CACHE_DIR:-/tmp/numba-cache}"
mkdir -p "$NUMBA_CACHE_DIR"

lock_network() {
  if [ "${VOXPOD_LOCK_NETWORK:-1}" != "1" ]; then
    echo "voxpod: outbound network lock disabled"
    return 0
  fi
  if ! command -v iptables >/dev/null 2>&1; then
    echo "voxpod: iptables is missing; outbound lock skipped" >&2
    return 0
  fi
  if ! iptables -A OUTPUT -o lo -j ACCEPT; then
    echo "voxpod: could not lock outbound network. Start with --cap-add NET_ADMIN." >&2
    echo "voxpod: the app still refuses to download models (HF_HUB_OFFLINE=1)." >&2
    return 0
  fi
  if ! iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; then
    echo "voxpod: conntrack rule failed; outbound lock skipped" >&2
    return 0
  fi
  iptables -A OUTPUT -j REJECT
  echo "voxpod: new outbound connections are blocked"
}

if [ "$(id -u)" = "0" ]; then
  lock_network
  mkdir -p /data
  chown voxpod:voxpod /data
  exec runuser -u voxpod -- "$@"
fi

exec "$@"

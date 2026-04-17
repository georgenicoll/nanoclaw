#!/bin/bash
# ensure-docker-running.sh — Ensure Docker daemon is running; start it if not.
# Usage: ./setup/scripts/ensure-docker-running.sh [MAX_WAIT_SECONDS]
# Emits a status block. Exit 0 if running, 1 on timeout, 2 if not installed.
set -euo pipefail

MAX_WAIT="${1:-60}"
PLATFORM=$(uname -s)

emit() {
  local status="$1"
  shift
  echo "=== DOCKER ==="
  echo "STATUS: $status"
  echo "PLATFORM: $PLATFORM"
  for line in "$@"; do
    echo "$line"
  done
  echo "=== END ==="
}

if docker info >/dev/null 2>&1; then
  emit "running" "STARTED: false"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  emit "not_installed"
  exit 2
fi

case "$PLATFORM" in
  Darwin)
    open -a Docker >/dev/null 2>&1 || true
    ;;
  Linux)
    # Try user-level systemd first, fall back to system (may prompt for sudo).
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user start docker 2>/dev/null \
        || sudo systemctl start docker 2>/dev/null \
        || true
    else
      sudo service docker start 2>/dev/null || true
    fi
    ;;
  *)
    emit "unsupported_platform"
    exit 3
    ;;
esac

for i in $(seq 1 "$MAX_WAIT"); do
  if docker info >/dev/null 2>&1; then
    emit "running" "STARTED: true" "WAITED: ${i}s"
    exit 0
  fi
  sleep 1
done

emit "timeout" "WAITED: ${MAX_WAIT}s"
exit 1

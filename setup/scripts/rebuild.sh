#!/bin/bash
# rebuild.sh — Install deps and rebuild the host. Use after merging a channel
# skill to pick up new packages.
# Usage: ./setup/scripts/rebuild.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"
mkdir -p "$(dirname "$LOG_FILE")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [rebuild] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

log "=== rebuild started ==="

if ! pnpm install >>"$LOG_FILE" 2>&1; then
  echo "=== REBUILD ==="
  echo "STATUS: failed"
  echo "STAGE: install"
  echo "LOG: logs/setup.log"
  echo "=== END ==="
  exit 1
fi

if ! pnpm run build >>"$LOG_FILE" 2>&1; then
  echo "=== REBUILD ==="
  echo "STATUS: failed"
  echo "STAGE: build"
  echo "LOG: logs/setup.log"
  echo "=== END ==="
  exit 1
fi

log "=== rebuild completed ==="

echo "=== REBUILD ==="
echo "STATUS: success"
echo "=== END ==="

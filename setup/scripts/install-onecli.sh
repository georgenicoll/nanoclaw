#!/bin/bash
# install-onecli.sh — Install OneCLI gateway + CLI, fix PATH, point CLI at the
# local instance, and write ONECLI_URL to .env. Idempotent.
# Emits a status block. Exit 0 on success, non-zero on failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"
mkdir -p "$(dirname "$LOG_FILE")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [install-onecli] $*" >> "$LOG_FILE"; }

ensure_profile_path() {
  local profile="$1"
  [ -f "$profile" ] || return 0
  if ! grep -q '.local/bin' "$profile" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$profile"
    log "added .local/bin PATH to $profile"
  fi
}

cd "$PROJECT_ROOT"

log "=== install-onecli started ==="

# 1. Install OneCLI service
log "installing OneCLI service"
INSTALL_OUT=$(mktemp)
if ! curl -fsSL onecli.sh/install | sh >"$INSTALL_OUT" 2>&1; then
  cat "$INSTALL_OUT" >> "$LOG_FILE"
  echo "=== ONECLI_INSTALL ==="
  echo "STATUS: failed"
  echo "STAGE: service_install"
  echo "LOG: logs/setup.log"
  echo "=== END ==="
  rm -f "$INSTALL_OUT"
  exit 1
fi
cat "$INSTALL_OUT" >> "$LOG_FILE"

# Parse ONECLI_URL from install output (installer prints it).
ONECLI_URL=$(grep -oE 'https?://[^[:space:]]+' "$INSTALL_OUT" | head -1 || true)
if [ -z "$ONECLI_URL" ]; then
  # Some installer versions print `ONECLI_URL=...`
  ONECLI_URL=$(grep -oE 'ONECLI_URL=\S+' "$INSTALL_OUT" | head -1 | cut -d= -f2- || true)
fi
rm -f "$INSTALL_OUT"

# 2. Install OneCLI CLI tool
log "installing OneCLI CLI"
if ! curl -fsSL onecli.sh/cli/install | sh >>"$LOG_FILE" 2>&1; then
  echo "=== ONECLI_INSTALL ==="
  echo "STATUS: failed"
  echo "STAGE: cli_install"
  echo "LOG: logs/setup.log"
  echo "=== END ==="
  exit 1
fi

# 3. Ensure ~/.local/bin is in PATH for this session + persist
export PATH="$HOME/.local/bin:$PATH"
ensure_profile_path "$HOME/.bashrc"
ensure_profile_path "$HOME/.zshrc"

# 4. Verify CLI is reachable
if ! command -v onecli >/dev/null 2>&1; then
  echo "=== ONECLI_INSTALL ==="
  echo "STATUS: failed"
  echo "STAGE: verify_cli"
  echo "ERROR: onecli command not found after install"
  echo "LOG: logs/setup.log"
  echo "=== END ==="
  exit 1
fi
ONECLI_VERSION=$(onecli version 2>/dev/null | head -1 || echo "unknown")
log "onecli version: $ONECLI_VERSION"

# 5. Point CLI at local instance and persist ONECLI_URL to .env (if detected).
URL_CONFIGURED="false"
if [ -n "${ONECLI_URL:-}" ]; then
  onecli config set api-host "$ONECLI_URL" >>"$LOG_FILE" 2>&1 || true
  "$SCRIPT_DIR/upsert-env.sh" ONECLI_URL "$ONECLI_URL" >>"$LOG_FILE"
  URL_CONFIGURED="true"
  log "configured ONECLI_URL=$ONECLI_URL"
fi

echo "=== ONECLI_INSTALL ==="
echo "STATUS: success"
echo "ONECLI_VERSION: $ONECLI_VERSION"
echo "ONECLI_URL: ${ONECLI_URL:-not_detected}"
echo "URL_CONFIGURED: $URL_CONFIGURED"
echo "LOG: logs/setup.log"
echo "=== END ==="

#!/bin/bash
# restart-service.sh — Platform-aware NanoClaw service control.
# Usage: ./setup/scripts/restart-service.sh [start|stop|restart]
# Emits a status block.
set -euo pipefail

ACTION="${1:-restart}"
PLATFORM=$(uname -s)

case "$ACTION" in
  start|stop|restart) ;;
  *)
    echo "Usage: restart-service.sh [start|stop|restart]" >&2
    exit 2
    ;;
esac

emit() {
  echo "=== SERVICE ==="
  echo "STATUS: $1"
  echo "ACTION: $ACTION"
  echo "PLATFORM: $PLATFORM"
  shift
  for line in "$@"; do
    echo "$line"
  done
  echo "=== END ==="
}

case "$PLATFORM" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.nanoclaw.plist"
    if [ ! -f "$PLIST" ]; then
      emit "not_installed" "PLIST: $PLIST"
      exit 1
    fi
    case "$ACTION" in
      start)
        launchctl load "$PLIST" 2>/dev/null || true
        launchctl kickstart "gui/$(id -u)/com.nanoclaw" >/dev/null 2>&1 || true
        ;;
      stop)
        launchctl unload "$PLIST" 2>/dev/null || true
        ;;
      restart)
        launchctl unload "$PLIST" 2>/dev/null || true
        launchctl load "$PLIST"
        ;;
    esac
    emit "done"
    ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      if systemctl --user list-unit-files nanoclaw.service >/dev/null 2>&1; then
        systemctl --user "$ACTION" nanoclaw
      else
        sudo systemctl "$ACTION" nanoclaw
      fi
      emit "done"
    else
      # WSL or systemd-less environment — use the wrapper.
      case "$ACTION" in
        start)
          bash start-nanoclaw.sh
          ;;
        stop)
          pkill -f 'node.*nanoclaw' || true
          ;;
        restart)
          pkill -f 'node.*nanoclaw' || true
          sleep 1
          bash start-nanoclaw.sh
          ;;
      esac
      emit "done" "MODE: wrapper"
    fi
    ;;
  *)
    emit "unsupported_platform"
    exit 3
    ;;
esac

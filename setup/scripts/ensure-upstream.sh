#!/bin/bash
# ensure-upstream.sh — Idempotently ensure `upstream` git remote is set.
# Usage: ./setup/scripts/ensure-upstream.sh [URL]
#        URL defaults to qwibitai/nanoclaw.
set -euo pipefail

REPO_URL="${1:-https://github.com/qwibitai/nanoclaw.git}"

if ! git remote | grep -qx upstream; then
  git remote add upstream "$REPO_URL"
  echo "STATUS: added"
  echo "UPSTREAM: $REPO_URL"
  exit 0
fi

current=$(git remote get-url upstream 2>/dev/null || echo "")
if [ "$current" = "$REPO_URL" ]; then
  echo "STATUS: already_set"
  echo "UPSTREAM: $current"
else
  echo "STATUS: mismatch"
  echo "UPSTREAM: $current"
  echo "EXPECTED: $REPO_URL"
fi

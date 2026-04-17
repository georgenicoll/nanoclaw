#!/bin/bash
# upsert-env.sh — Idempotently set KEY=VALUE in .env
# Usage: ./setup/scripts/upsert-env.sh KEY VALUE [ENV_FILE]
#        ENV_FILE defaults to .env in the current working directory.
# Values with `|` in them are not supported (used internally as sed delimiter).
set -euo pipefail

KEY="${1:?Usage: upsert-env.sh KEY VALUE [ENV_FILE]}"
VALUE="${2:?Usage: upsert-env.sh KEY VALUE [ENV_FILE]}"
ENV_FILE="${3:-.env}"

touch "$ENV_FILE"

if grep -q "^${KEY}=" "$ENV_FILE" 2>/dev/null; then
  sed -i.bak "s|^${KEY}=.*|${KEY}=${VALUE}|" "$ENV_FILE"
  rm -f "${ENV_FILE}.bak"
  echo "updated ${KEY} in ${ENV_FILE}"
else
  echo "${KEY}=${VALUE}" >> "$ENV_FILE"
  echo "appended ${KEY} to ${ENV_FILE}"
fi

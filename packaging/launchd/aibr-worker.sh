#!/usr/bin/env bash
#
# launchd wrapper for the ingress drain worker.
#
# Same reason as `aibr-router.sh`: launchd has no `ExecStartPre`, so the systemd
# unit's provisioning step happens here instead. It is executed BEFORE
# `aibr worker` rather than inside it, because the worker refuses to create the
# store it drains -- a refusal that belongs at install time, where an operator is
# watching, not on every respawn at 3am.

set -euo pipefail

ENV_FILE="${AIBRIDGE_ENV_FILE:-/etc/aibridge/router.env}"
ROUTER_BIN="${AIBRIDGE_ROUTER_BIN:-/usr/local/bin/aibr-router}"

if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
else
  echo "aibr-worker: $ENV_FILE is missing or unreadable." >&2
  echo "It must define AIBRIDGE_INGRESS_OUTBOX and AIBRIDGE_WORKER_PROFILE." >&2
  exit 78
fi

: "${AIBRIDGE_INGRESS_OUTBOX:?aibr-worker: AIBRIDGE_INGRESS_OUTBOX is required}"
: "${AIBRIDGE_WORKER_PROFILE:?aibr-worker: AIBRIDGE_WORKER_PROFILE is required}"

"$ROUTER_BIN" --init-store

exec /usr/local/bin/aibr worker --profile "$AIBRIDGE_WORKER_PROFILE"

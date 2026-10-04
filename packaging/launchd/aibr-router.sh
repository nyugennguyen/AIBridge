#!/usr/bin/env bash
#
# launchd wrapper for `aibr-router`.
#
# ## Why this exists instead of a bare ProgramArguments
#
# launchd has no `ExecStartPre`. The systemd unit's admission-store provisioning
# and its bind preflight are two ordered steps that run BEFORE the process that
# depends on them, and both are refusals worth having: without them a launchd
# job either never starts (store missing, exit 78) or starts against an address
# that is not on the tailnet. Putting the same two steps here — in the same
# order, from the same binary — is what keeps the two platforms honest.
#
# systemd expresses the environment with `EnvironmentFile=`; here the wrapper
# sources the same file, so one file configures both platforms.

set -euo pipefail

ENV_FILE="${AIBRIDGE_ENV_FILE:-/etc/aibridge/router.env}"
ROUTER_BIN="${AIBRIDGE_ROUTER_BIN:-/usr/local/bin/aibr-router}"

if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
else
  echo "aibr-router: $ENV_FILE is missing or unreadable." >&2
  echo "It must define AIBRIDGE_CONFIG, AIBRIDGE_BEARER_TOKEN and AIBRIDGE_INGRESS_OUTBOX." >&2
  exit 78
fi

: "${AIBRIDGE_INGRESS_OUTBOX:?aibr-router: AIBRIDGE_INGRESS_OUTBOX is required}"

# 1. Provision the admission store. Idempotent: exit 0 when it already exists,
#    exit 78 when the path holds something that is not a store. Ordered before
#    the preflight on purpose -- provisioning succeeding says nothing about the
#    address, and preflighting first would fail on the missing store instead.
"$ROUTER_BIN" --init-store

# 2. Load config, open the store, check the bind address. Binds nothing.
"$ROUTER_BIN" --preflight

# 3. Hand the process over. `exec` so launchd's SIGTERM and KeepAlive restarts
#    reach the router itself rather than a shell that would swallow them.
exec "$ROUTER_BIN"

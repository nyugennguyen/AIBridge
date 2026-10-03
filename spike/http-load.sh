#!/usr/bin/env bash
# SPIKE CODE -- NOT PRODUCTION. Fixed-rate HTTP load driver for M7.1.
#
# Milestone 7 §5.1.1 requires "steady state under sustained load" because an idle
# Bun process is not a stationary quantity. This issues the profile's fixed rate
# of requests at whatever ingress endpoint is listening, and never stops until
# killed.
#
# It is deliberately dumb: one curl per request, no keepalive, no concurrency.
# A smarter client would measure the client's behaviour instead of the server's
# steady state, and the socket path is a small term next to the in-process load
# loop that runs inside the measured process anyway.
#
# Usage: spike/http-load.sh URL TOKEN RATE_PER_SECOND

set -euo pipefail

URL="${1:?usage: http-load.sh URL TOKEN RATE_PER_SECOND}"
TOKEN="${2:?missing bearer token}"
RATE="${3:?missing rate per second}"

# Read out of load-profile.json rather than duplicated here: two copies of a
# payload that must be byte-identical across topologies is a drift surface with
# no upside.
PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["payload"]))' \
  "$(dirname "$0")/load-profile.json")
PERIOD=$(awk -v r="$RATE" 'BEGIN { printf "%.4f", 1 / r }')

# The child is killed explicitly on exit, because a shell loop that spawns a
# command per iteration leaves that command as a child of this script: TERM to the
# script alone does not reap it, and a caller running `wait` blocks on it
# indefinitely. This cost one hung measurement run before it was found.
running=true
current_child=""
terminate() {
  running=false
  [ -n "$current_child" ] && kill "$current_child" 2>/dev/null || true
}
trap terminate TERM INT

issued=0
while "$running"; do
  curl -s -o /dev/null -m 5 -X POST "$URL" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data-binary "$PAYLOAD" &
  current_child=$!
  wait "$current_child" 2>/dev/null || true
  current_child=""
  issued=$((issued + 1))
  if [ $((issued % 250)) -eq 0 ]; then
    printf 'spike-http-load issued=%d\n' "$issued" >&2
  fi
  sleep "$PERIOD" &
  current_child=$!
  wait "$current_child" 2>/dev/null || true
  current_child=""
done
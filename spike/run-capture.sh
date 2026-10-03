#!/usr/bin/env bash
# SPIKE CODE -- NOT PRODUCTION. One measurement run for one topology, M7.1.
#
# Protocol, fixed by spike/load-profile.json and milestone 7 §5.1.1:
#   A1  >=1 Hz for >=60 s              (bench/mem.sh refuses anything less, exit 2)
#   A2  >=3 captures per quantity       (run this script N times; see run-all.sh)
#   A3  run-to-run spread <=10%         (computed by summarise.py, not here)
#   A4  same host, same boot, same profile for every capture, including the
#       baseline topology
#
# Three topologies, and only three. NATS was dropped from M7.1's scope when the
# broker was rejected in ADR 0008 §5, so there is no fourth topology and no
# broker anywhere in this directory.
#
#   A  engine + Fastify, listening        today's shipping composition, via the
#                                        real src/bridge.ts startBridge()
#   B  worker, no Fastify, no listener    THE NUMBER. ADR 0008 §2.1 projects
#                                        43.3 MiB for this process.
#   C  worker + router stub               the post-router topology, sum-first
#
# Everything is sequential and nothing else is sampled. Three capture runs must
# never overlap: they would contend for the same eight CPUs and the levels would
# measure each other.
#
# Usage: spike/run-capture.sh --topology A|B|C --out FILE [--label TEXT]

set -euo pipefail

SPIKE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SPIKE_DIR/.." && pwd)
BENCH="$REPO_ROOT/bench"
ENTRYPOINT="$SPIKE_DIR/engine-with-fastify.ts"
# Topology A's own bridge. The router stub binds an ephemeral port instead
# (--port-file), so this is only the address the Fastify topology listens on.
BIND_HOST="127.0.0.1"
BIND_PORT="8787"

TOPOLOGY=""
OUT=""
LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --topology) TOPOLOGY="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    *) printf 'spike/run-capture.sh: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$TOPOLOGY" in
  A) ;;
  B|C) ENTRYPOINT="$SPIKE_DIR/worker-no-fastify.ts" ;;
  *) printf 'spike/run-capture.sh: --topology must be A, B or C\n' >&2; exit 2 ;;
esac
[ -n "$OUT" ] || { printf 'spike/run-capture.sh: --out is required\n' >&2; exit 2; }

PROFILE="$SPIKE_DIR/load-profile.json"
WARMUP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["warmupSeconds"])' "$PROFILE")
SAMPLE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sampleSeconds"])' "$PROFILE")
INTERVAL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sampleIntervalSeconds"])' "$PROFILE")
HTTP_RATE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["httpRatePerSecond"])' "$PROFILE")

WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/aibr-spike.XXXXXX")
STATE_DIR="$WORKDIR/state"
ROUTER_PID=""
BRIDGE_PID=""
LOAD_PID=""

cleanup() {
  # TERM, then KILL, then a bounded wait. `wait` with no arguments waits for
  # EVERY child, so a single child that ignores TERM hangs the whole run -- which
  # is what happened: the load loop had installed a SIGTERM handler that cleared a
  # flag and exited nothing, and the first capture never returned. The handler is
  # gone from spike/load-loop.ts, and this is the belt to that pair of braces.
  terminate() {
    local signal="$1" pid child
    for pid in "$LOAD_PID" "$BRIDGE_PID" "$ROUTER_PID"; do
      [ -n "$pid" ] || continue
      kill "-$signal" "$pid" 2>/dev/null || true
      # The HTTP load driver is a shell loop whose current curl/sleep is its own
      # child; TERM to the shell alone leaves that child running, and `wait` below
      # then blocks on it. Signalling the children is what actually frees the slot.
      for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        kill "-$signal" "$child" 2>/dev/null || true
      done
    done
  }
  terminate TERM
  ( sleep 5; terminate KILL ) &
  wait 2>/dev/null || true
  printf '%s\n' "--- spike/run-capture.sh logs ---" >&2
  for log in "$WORKDIR"/*.log; do
    [ -f "$log" ] || continue
    printf '### %s\n' "$(basename "$log")" >&2
    tail -n 25 "$log" >&2
  done
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$STATE_DIR"
mkdir -p "$(dirname "$OUT")"

export AIBRIDGE_CONFIG="$REPO_ROOT/bench/baseline/capture-config.json"
export AIBRIDGE_BEARER_TOKEN=spike-not-a-secret
export OPENCODE_SERVER_PASSWORD=spike-not-a-secret
export SPIKE_STATE_DIR="$STATE_DIR"
export SPIKE_LOAD_PROFILE="$PROFILE"

# WHY THE HOST'S MEMORY STATE IS RECORDED IN EVERY ARTEFACT.
#
# This spike saw the same worker entrypoint measure 47.7 MiB in a standalone
# capture and 64.9 MiB in a later one, on the same host and boot, with the same
# profile and comparable within-session spread. Both sessions were internally
# consistent and both looked trustworthy; they disagree by 17 MiB.
#
# The machine had ~4 GiB of swap in use from unrelated GUI applications during
# the second. Under memory pressure a process is not allowed to return pages, so
# its RSS reflects how much the HOST is short of memory as much as what the
# process does. That makes every figure in this spike conditional on a host state
# that §5.1.1 A4 ("same host, same boot") does not capture: same host, same boot,
# different memory pressure.
#
# Stamping the pressure into each artefact costs nothing and is the only thing
# that lets a later reader tell a real regression from a host that filled up.
host_memory_state() {
  local swap_used pressure
  swap_used=$(sysctl -n vm.swapusage 2>/dev/null | sed -n 's/.*used = \([0-9.]*\)[A-Z]*.*/\1/p')
  pressure=$(memory_pressure 2>/dev/null | sed -n 's/.*System-wide memory free percentage: *\([0-9]*\)%.*/\1/p')
  printf 'swapUsedMib=%s, memoryFreePercent=%s' "${swap_used:-unknown}" "${pressure:-unknown}"
}

if [ "$TOPOLOGY" = "B" ] || [ "$TOPOLOGY" = "C" ]; then
  printf 'spike: topology %s -- starting the router measurement stub\n' "$TOPOLOGY" >&2
  STUB="$SPIKE_DIR/router-stub/target/release/aibr-router-stub"
  [ -x "$STUB" ] || { printf 'spike: build the stub first: (cd spike/router-stub && cargo build --release)\n' >&2; exit 1; }
  "$STUB" --bind "$BIND_HOST:0" --port-file "$WORKDIR/stub.port" > "$WORKDIR/router.log" 2>&1 &
  ROUTER_PID=$!

  # Readiness is this capture's OWN stub, identified by pid, not "is something
  # listening on a port". The stub writes the port the kernel gave it and is
  # checked for the write, so a stub that died on bind cannot leave a stale port
  # file behind to be read as success.
  ready=no
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    attempt=$((attempt + 1))
    kill -0 "$ROUTER_PID" 2>/dev/null || { printf 'spike: the router stub exited\n' >&2; cat "$WORKDIR/router.log" >&2; exit 1; }
    if [ -s "$WORKDIR/stub.port" ]; then ready=yes; break; fi
    sleep 0.25
  done
  if [ "$ready" != "yes" ]; then
    printf 'spike: the router stub never reported a bound port\n' >&2
    cat "$WORKDIR/router.log" >&2
    exit 1
  fi
  STUB_PORT=$(cat "$WORKDIR/stub.port")
  printf 'spike: router stub pid %s on %s:%s\n' "$ROUTER_PID" "$BIND_HOST" "$STUB_PORT" >&2
fi

printf 'spike: topology %s -- starting %s\n' "$TOPOLOGY" "$(basename "$ENTRYPOINT")" >&2
(
  cd "$REPO_ROOT"
  exec bun "$ENTRYPOINT"
) > "$WORKDIR/bridge.log" 2>&1 &
BRIDGE_PID=$!

# A listener that never came up would produce an artefact whose every row is a
# measurement of an absent process. Same rule as bench/capture-baseline.sh. In
# topology B the worker opens no socket at all, so the readiness probe targets
# the stub; in A and C it targets the ingress listener.
if [ "$TOPOLOGY" = "A" ]; then
  PROBE_PORT="$BIND_PORT"
else
  PROBE_PORT="$STUB_PORT"
fi
ready=no
attempt=0
while [ "$attempt" -lt 60 ]; do
  attempt=$((attempt + 1))
  kill -0 "$BRIDGE_PID" 2>/dev/null || { printf 'spike: the Bun process exited during startup\n' >&2; cat "$WORKDIR/bridge.log" >&2; exit 1; }
  code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://$BIND_HOST:$PROBE_PORT/health" || printf '000')
  case "$code" in
    000) sleep 0.5 ;;
    *) ready=yes; break ;;
  esac
done
[ "$ready" = yes ] || { printf 'spike: nothing answering on %s\n' "$PROBE_PORT" >&2; exit 1; }

printf 'spike: ingress up; starting the fixed-rate HTTP load at %s/s\n' "$HTTP_RATE" >&2
"$SPIKE_DIR/http-load.sh" "http://$BIND_HOST:$PROBE_PORT/trigger" "$AIBRIDGE_BEARER_TOKEN" "$HTTP_RATE" \
  > "$WORKDIR/httpload.log" 2>&1 &
LOAD_PID=$!

printf 'spike: warming for %ss (excluded from the reported series)\n' "$WARMUP" >&2
sleep "$WARMUP"

# bench/mem.sh is called directly rather than through bench/three-process.sh
# because three-process.sh's argv fallbacks are `src/index.ts`, `aibr serve` and
# `aibridge-dev`, and no process started from spike/ matches any of them. The slot
# layout and the annotations are the same, so the artefact keeps the SUM as the
# primary number and keeps the headline warning.
# ONE slot per process that can actually be present in this topology. An earlier
# revision declared both `spike-worker|<entrypoint>` and
# `spike-engine|engine-with-fastify.ts` in every run: under topology A both argv
# alternatives matched the SAME process, and the SUM came out at 124.6 MiB for a
# 62.3 MiB engine -- a slot list that double-counts is worse than no slot list,
# because the harness reports it faithfully and the error is invisible unless you
# check the per-process rows against the topology.
#
# bench/mem.sh excludes itself, its ancestors and its direct children from
# matching, which is what keeps this shell script's own argv (which names the
# entrypoint) out of the sum.
SLOTS="spike-bun-process|$ENTRYPOINT"
case "$TOPOLOGY" in
  B|C) SLOTS="spike-router-stub|aibr-router-stub,$SLOTS" ;;
esac

"$BENCH/mem.sh" \
  --pid "$SLOTS" \
  --interval "$INTERVAL" \
  --duration "$SAMPLE" \
  --annotate "topology=$TOPOLOGY" \
  --annotate "label=${LABEL:-}" \
  --annotate "spike=true -- SPIKE ARTEFACT, single host, single session, not a soak" \
  --annotate "primaryMetric=sum.rssMib.median (MiB, absolute level)" \
  --annotate "headlineWarning=router-only figures are not a host-level result; opencode serve, the ~20 MiB Bun runtime floor, and @opentui/core are untouched. The primary number is the per-tick SUM across the processes that were alive; per-process figures are secondary." \
  --annotate "loadProfile=$PROFILE" \
  --annotate "hostMemoryState=$(host_memory_state)" \
  --out "$OUT" || printf 'spike/run-capture.sh: bench/mem.sh exited %s\n' "$?" >&2

# Refuse a capture whose slots overlap. bench/mem.sh records the resolved pid set
# per slot, so this is a check rather than a hope, and it is the check that would
# have caught the double-counted topology A sum. A SUM that includes one process
# twice is a fabricated figure wearing a measurement's clothes.
python3 - "$OUT" "$TOPOLOGY" <<'PY'
import json, sys

path, topology = sys.argv[1], sys.argv[2]
with open(path) as handle:
    document = json.load(handle)

seen: dict[int, str] = {}
overlaps = []
absent = []
for name, value in (document.get("processes") or {}).items():
    ticks = value.get("absentTicks") or 0
    total = (document.get("sampling") or {}).get("ticksObserved") or 0
    if ticks >= total:
        absent.append(name)
        continue
    for pid in value.get("pids") or []:
        if pid in seen:
            overlaps.append(f"pid {pid} counted in both '{seen[pid]}' and '{name}'")
        seen[pid] = name

expected = {"A": 1, "B": 2, "C": 2}[topology]
present = len(seen)

if overlaps:
    print("spike/run-capture.sh: REFUSING this capture, slots overlap:", file=sys.stderr)
    for line in overlaps:
        print(f"  {line}", file=sys.stderr)
    sys.exit(1)

if present != expected:
    print(
        f"spike/run-capture.sh: topology {topology} resolved {present} distinct "
        f"process(es), expected {expected} (absent slots: {', '.join(absent) or 'none'})",
        file=sys.stderr,
    )
    if present < expected:
        print(
            "  a missing process would make the SUM a smaller number than the topology "
            "actually costs, so this capture is refused rather than reported",
            file=sys.stderr,
        )
        sys.exit(1)
    print("  more processes than expected; reporting and letting the reviewer judge", file=sys.stderr)
else:
    print(f"spike/run-capture.sh: slot check ok -- {present} distinct process(es) for topology {topology}", file=sys.stderr)
PY

printf 'spike: wrote %s\n' "$OUT" >&2
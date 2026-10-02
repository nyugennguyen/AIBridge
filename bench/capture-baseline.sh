#!/usr/bin/env bash
# bench/capture-baseline.sh -- reproduce ADR 0008 section 1's baseline and write
# bench/baseline/engines.json.
#
# WHAT THIS PRODUCES, and what it deliberately does not:
#   * The steady-state figure, via bench/three-process.sh: absolute RSS levels at
#     >=1 Hz for >=60 s, median and p95, per process and as a SUM.
#   * The import ladder, via bench/imports-probe.sh: one step per fresh process,
#     reported as levels.
#   * A "partial" flag and a "missing" list naming the ADR 0008 section 1 rows
#     that could NOT be reproduced on this host, and why.
#
# The missing list is not a formality. An ADR table row that cannot be reproduced
# here must be absent from the artefact and named in it, not estimated and left
# to look measured. A baseline with a plausible invented row is worse than a
# baseline with a short one.
#
# THE HOST THIS RUNS ON DOES NOT HAVE tailscale0, so the bridge is bound to
# loopback with bench/baseline/capture-config.json (a copy of
# config/dev-main.example.json with the host rewritten). That is a documented
# deviation from the ADR's reference host, recorded in the artefact.
#
# Usage: bench/capture-baseline.sh [--out FILE] [--duration SECONDS]
#                                [--warmup SECONDS] [--repeat N]
# Exit:  0 = captured; 1 = the bridge could not be started; 2 = usage error

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
CONFIG="$REPO_ROOT/bench/baseline/capture-config.json"
OUT="$SCRIPT_DIR/baseline/engines.json"
DURATION=60
WARMUP_SECONDS=10
REPEAT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    --duration) DURATION="${2:-}"; shift 2 ;;
    --repeat) REPEAT="${2:-}"; shift 2 ;;
    --warmup) WARMUP_SECONDS="${2:-}"; shift 2 ;;
    *) printf '%s\n' "bench/capture-baseline.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if ! printf '%s' "$REPEAT" | grep -Eq '^[0-9]+$' || [ "$REPEAT" -lt 1 ]; then
  printf '%s\n' "bench/capture-baseline.sh: --repeat must be a positive integer" >&2
  exit 2
fi

for tool in bun ps awk; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'bench/capture-baseline.sh: %s is required\n' "$tool" >&2; exit 1; }
done
[ -f "$CONFIG" ] || { printf 'bench/capture-baseline.sh: missing %s\n' "$CONFIG" >&2; exit 1; }

WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/aibr-bench-capture.XXXXXX")
BRIDGE_PID=""
cleanup() {
  if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

printf '%s\n' "starting the bridge (bun src/index.ts, loopback, capture-config.json)" >&2
# A dummy bearer token and opencode password: the baseline measures resident
# memory of an idle listener, not the authentication path. Real credentials are
# not needed to open a socket and must not be baked into a committed artefact.
(
  cd "$REPO_ROOT"
  AIBRIDGE_CONFIG="$CONFIG" \
  AIBRIDGE_BEARER_TOKEN=bench-baseline-not-a-secret \
  OPENCODE_SERVER_PASSWORD=bench-baseline-not-a-secret \
  exec bun src/index.ts
) > "$WORKDIR/bridge.log" 2>&1 &
BRIDGE_PID=$!

# Wait for the listener. A bridge that fails to bind is a failed capture, not a
# baseline of zero: continuing would commit an artefact whose every row is a
# measurement of an absent process.
ready="no"
attempt=0
while [ "$attempt" -lt 40 ]; do
  attempt=$((attempt + 1))
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    printf '%s\n' "bench/capture-baseline.sh: the bridge exited during startup:" >&2
    cat "$WORKDIR/bridge.log" >&2
    exit 1
  fi
  code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health 2>/dev/null || printf '000')
  # Any HTTP status means the listener is up and Fastify is routing. /health
  # legitimately returns 500 when opencode serve is unreachable, which is the
  # normal state of a capture host with no opencode process.
  case "$code" in
    000) sleep 0.5 ;;
    *) ready="yes"; break ;;
  esac
done
if [ "$ready" != "yes" ]; then
  printf '%s\n' "bench/capture-baseline.sh: the bridge never began listening on 127.0.0.1:8787" >&2
  cat "$WORKDIR/bridge.log" >&2
  exit 1
fi

printf '%s\n' "bridge up (pid $BRIDGE_PID); warming for ${WARMUP_SECONDS}s before sampling" >&2
# Warmed before sampling, and deliberately NOT part of the reported series: lazy
# JIT allocation means the first seconds after start under-report, and a warmup
# whose samples leaked into the distribution would defeat the exclusion.
sleep "$WARMUP_SECONDS"

printf '%s\n' "" >&2
printf '%s\n' "=== steady state: bench/three-process.sh ===" >&2
# The idle level of a Bun process is not a settled quantity: JSC returns pages to
# its allocator over time, so a compliant 60 s window can end anywhere in a range.
# Repeating a COMPLIANT capture measures the harness's own noise floor, which is
# the number that decides whether the 5% floor in lib/stats.sh is conservative
# for this system or dangerously optimistic. One capture cannot tell you that.
run_index=0
while [ "$run_index" -lt "$REPEAT" ]; do
  run_index=$((run_index + 1))
  if [ "$REPEAT" -gt 1 ]; then
    printf '%s\n' "--- steady-state run $run_index of $REPEAT" >&2
  fi
  "$SCRIPT_DIR/three-process.sh" --duration "$DURATION" \
    --out "$WORKDIR/steady-$run_index.json" || true
done
cp "$WORKDIR/steady-1.json" "$WORKDIR/steady.json" 2>/dev/null || true

printf '%s\n' "" >&2
printf '%s\n' "=== import ladder: bench/imports-probe.sh ===" >&2
"$SCRIPT_DIR/imports-probe.sh" --repeats 7 --out "$WORKDIR/imports.json" >/dev/null || true

printf '%s\n' "" >&2
printf '%s\n' "=== admission latency: bench/latency.sh ===" >&2
# Measured against the real bridge listener, so /health returning 500 (no
# opencode serve on this host) counts as a failed request and is reported as
# such rather than averaged into a latency figure. The latency row is therefore
# expected to be unmeasured here; that is recorded in "missing" below.
"$SCRIPT_DIR/latency.sh" --url http://127.0.0.1:8787/health --requests 20 --warmup 5 \
  --out "$WORKDIR/latency.json" || true

# --- assemble -------------------------------------------------------------
python3 - "$WORKDIR" "$OUT" "$REPO_ROOT" <<'PY'
import json, os, subprocess, sys

workdir, out_path, repo = sys.argv[1], sys.argv[2], sys.argv[3]

def load(name):
    path = os.path.join(workdir, name)
    if not os.path.exists(path):
        return None
    with open(path) as handle:
        return json.load(handle)

steady = load("steady.json")
ladder = load("imports.json")
latency = load("latency.json")

def step_median(ladder, step):
    if not ladder or step not in ladder.get("steps", {}):
        return None
    return ladder["steps"][step].get("levelMib")

# ADR 0008 section 1 rows, and whether this host reproduced each one. Stated as
# data rather than prose so a reviewer can diff it against the ADR table.
adr_rows = [
    ("Bun process floor", step_median(ladder, "floor"), "imports-probe floor step"),
    ("import fastify", step_median(ladder, "fastify"), "imports-probe fastify step"),
    ("import zod", step_median(ladder, "zod"), "imports-probe zod step"),
    ("import @opencode-ai/sdk/v2", step_median(ladder, "sdk"), "imports-probe sdk step"),
    ("Zod parse of a full config.json", step_median(ladder, "config"), "imports-probe config step"),
    ("src/server/app.ts routes", step_median(ladder, "routes"), "imports-probe routes step"),
    ("JsonFileJobStore first write", step_median(ladder, "jobstore"), "imports-probe jobstore step"),
    ("app.listen()", step_median(ladder, "listen"), "imports-probe listen step"),
]

missing = []
if steady is None:
    missing.append({
        "row": "End-to-end running bridge idle RSS",
        "why": "the bridge could not be started on this host; no steady-state capture was produced",
    })
if not any(median is not None for _, median, _ in adr_rows):
    missing.append({
        "row": "import ladder",
        "why": "no import-probe step produced samples",
    })
if latency is None or latency.get("samples", 0) == 0:
    missing.append({
        "row": "Admission latency p50/p99",
        "why": ("no opencode serve is reachable on this host, so /health returns HTTP 500 for every "
                "request and bench/latency.sh correctly refuses to report a distribution of failures. "
                "Latency targets in section 5.2 are therefore NOT baselined by this artefact."),
    })
missing.append({
    "row": "aibr tui resident memory",
    "why": ("the TUI is interactive and requires a TTY; it cannot be started non-interactively, so its "
            "level is absent. The sum below therefore covers the processes that were alive, and the "
            "post-router three-process total is not comparable to this figure until the TUI is measured."),
})
missing.append({
    "row": "aibr-router resident memory",
    "why": "the router does not exist until M7.1; reported absent, not zero",
})
missing.append({
    "row": "CPU idle percent and 500-request burst cost",
    "why": "out of scope for M7.0, which delivers the memory and latency harness only; section 5.2 rows remain unbaselined",
})

# Run-to-run variance across repeated COMPLIANT captures. This is the harness's
# own noise floor for this system, and it is what decides whether the 5% floor in
# bench/lib/stats.sh is safe to gate on. If the spread across identical compliant
# runs approaches the size of the effect being measured, the gate cannot be
# evaluated from a single capture and M7.16 must say so.
repeat_captures = []
for index in range(1, 64):
    candidate = load(f"steady-{index}.json")
    if candidate is None:
        break
    dist = (candidate.get("sum") or {}).get("rssMib") or {}
    repeat_captures.append({
        "run": index,
        "generatedAt": candidate.get("generatedAt"),
        "shortSample": ((candidate.get("sampling") or {}).get("shortSample")),
        "sumMedianMib": dist.get("median"),
        "sumP95Mib": dist.get("p95"),
        "sumP5Mib": dist.get("p5"),
        "workerMedianMib": (((candidate.get("processes") or {}).get("aibr-worker") or {}).get("rssMib") or {}).get("median"),
        # The raw series are kept so a reviewer can re-run bench_compare between
        # any two runs without recapturing, and so the variance claim above can
        # be checked rather than taken on trust.
        "series": candidate.get("series"),
    })

run_to_run = None
medians = [r["sumMedianMib"] for r in repeat_captures if r.get("sumMedianMib") is not None]
p95s = [r["sumP95Mib"] for r in repeat_captures if r.get("sumP95Mib") is not None]
if len(medians) > 1:
    ordered = sorted(medians)
    middle = ordered[len(ordered) // 2]
    spread = ordered[-1] - ordered[0]
    ordered_p95 = sorted(p95s) if p95s else [None, None]
    run_to_run = {
        "runs": len(medians),
        "sumMedianMinMib": ordered[0],
        "sumMedianMaxMib": ordered[-1],
        "sumMedianSpreadMib": round(spread, 3),
        "sumMedianSpreadPctOfMedian": round(100.0 * spread / middle, 2) if middle else None,
        # p95 is gated on as well as the median (milestone 7 "Resource" criteria
        # require both), and it turns out to be the less stable of the two: an
        # idle Bun process spikes to a higher plateau transiently, which moves
        # p95 by tens of MiB between runs that agree on the median.
        "sumP95MinMib": ordered_p95[0],
        "sumP95MaxMib": ordered_p95[-1],
        "sumP95SpreadMib": round(ordered_p95[-1] - ordered_p95[0], 3) if len(ordered_p95) > 1 else None,
        "sumP95SpreadPctOfMedian": (
            round(100.0 * (ordered_p95[-1] - ordered_p95[0]) / middle, 2)
            if len(ordered_p95) > 1 and middle else None
        ),
        "note": ("Spread across identical, individually compliant captures. This is the system "
                 "measurement noise, and it is what a candidate run is actually being compared "
                 "against. If this exceeds the effect being measured, one capture per gate is "
                 "not a sufficient basis for a pass or a fail."),
        "perRun": repeat_captures,
    }
missing.append({
    "row": "Exact ADR 0008 section 1 numbers",
    "why": ("re-measured rather than copied. The ADR's figures were taken with a tailnet-bound bridge and "
            "a live opencode serve on a possibly different host and toolchain; this capture ran loopback with "
            "no opencode, so a difference against the ADR table is expected and is a deviation to reconcile "
            "in M7.16, not an error to hide."),
})

document = {
    "schema": "aibridge.bench.baseline/1",
    "generatedAt": subprocess.check_output(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"]).decode().strip(),
    "adrReference": "Docs/adr/0008-polyglot-ingress-and-admission.md section 1",
    "planReference": "Docs/implementation-plans/milestone-7-polyglot-ingress.md section 5.1",
    "quantity": "absolute RSS levels in MiB; no delta is reported anywhere in this artefact",
    "host": (steady or {}).get("host"),
    "reproduceWith": [
        "bun install",
        "bench/capture-baseline.sh",
    ],
    "hostDeviations": [
        "bridge bound to 127.0.0.1 (bench/baseline/capture-config.json) because this host has no tailscale0",
        "no opencode serve running, so /health returns HTTP 500 and no latency distribution is measurable",
        "no aibr tui, which requires a TTY",
    ],
    "partial": True,
    "missing": missing,
    "runToRunVariance": run_to_run,
    "adrSection1Rows": [
        {
            "row": row,
            "reproduced": median is not None,
            "medianMib": (median or {}).get("median"),
            "p95Mib": (median or {}).get("p95"),
            "samples": (median or {}).get("n"),
            "source": source,
        }
        for row, median, source in adr_rows
    ],
    "steadyState": steady,
    "steadyStateIsRun": 1,
    "importLadder": ladder,
    "latency": latency,
}

with open(out_path, "w") as handle:
    json.dump(document, handle, indent=2)
    handle.write("\n")

print(f"wrote {out_path}")
print(f"  partial: {len(missing)} named gaps")
if run_to_run:
    median_spread = run_to_run.get("sumMedianSpreadPctOfMedian") or 0
    p95_spread = run_to_run.get("sumP95SpreadPctOfMedian") or 0
    print(f"  run-to-run spread across {run_to_run['runs']} compliant captures: "
          f"SUM median {median_spread}%, SUM p95 {p95_spread}%")
    if median_spread > 10 or p95_spread > 10:
        print()
        print("  WARNING: identical, individually compliant captures of this UNCHANGED system disagree")
        print(f"  by up to {max(median_spread, p95_spread)}% of the median. A single 60 s capture is")
        print("  therefore not a reproducible baseline for this process, and a gate evaluated from")
        print("  one capture could report a change that is only allocator state. See")
        print("  runToRunVariance in the artefact and bench/README.md before citing any figure.")
PY

printf '%s\n' "" >&2
printf 'wrote %s\n' "$OUT"
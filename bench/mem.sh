#!/usr/bin/env bash
# bench/mem.sh -- sample absolute RSS levels of a process set over time.
#
# Reports the DISTRIBUTION of absolute RSS levels (median, p95, p5) per process
# and for their sum. It does not compute, print or store a difference between
# two samples: see ADR 0008 section 1, where RSS was observed to FALL across 500
# requests because JSC returned pages to its allocator. A delta here would report
# allocator behaviour as a resource win.
#
# Usage:
#   bench/mem.sh --samples N --interval SECONDS --pid NAME[,NAME...] \
#                --baseline FILE --out FILE
#   bench/mem.sh --all --duration 60 --out FILE
#   bench/mem.sh --self-test
#
# Options:
#   --samples N          number of samples (default 60)
#   --interval SECONDS   seconds between samples (default 1)
#   --duration SECONDS   derive the sample count from a total duration
#   --pid LIST           comma-separated process matchers (see MATCHER SYNTAX)
#   --all                sample the project's known process set
#   --baseline FILE      compare against a previously captured JSON baseline
#   --out FILE           write JSON here instead of stdout
#   --annotate K=V       add a top-level JSON string field; repeatable. Used by
#                        bench/three-process.sh to carry its headline warning
#                        into the artefact rather than only to the terminal.
#   --allow-short        take a non-compliant measurement; stamps shortSample
#   --self-test          run bench/selftest.sh and exit
#   --help               this text
#
# MATCHER SYNTAX
#   NAME                 resolved against the process `comm` name first, then as
#                        a substring of the full argv. Multiple PIDs matching one
#                        matcher are SUMMED and the count is recorded.
#   A|B|C               alternatives, first comm-exact match wins; argv substring
#                        is only consulted if no alternative matched a comm name.
#                        This lets "aibr-worker|aibr worker|aibr serve" identify
#                        the bridge whether it runs from source or from dist.
#
# EXIT CODES
#   0  measured; no baseline given, or every comparison passed/improved
#   1  runtime error (no such file, unwritable output)
#   2  usage error, or refused because the run violates >=1 Hz / >=60 s
#   3  a comparison regressed or was inconclusive (insufficient samples)

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/stats.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/stats.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/mem_probe.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/mem_probe.sh"

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then usage; exit 0; fi
if [ "${1:-}" = "--self-test" ]; then exec "$SCRIPT_DIR/selftest.sh"; fi

SAMPLES=""
INTERVAL=""
DURATION=""
PID_LIST=""
USE_ALL="false"
BASELINE=""
OUT=""
ALLOW_SHORT="false"
ANNOTATIONS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --samples) SAMPLES="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --duration) DURATION="${2:-}"; shift 2 ;;
    --pid) PID_LIST="${2:-}"; shift 2 ;;
    --all) USE_ALL="true"; shift ;;
    --baseline) BASELINE="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --allow-short) ALLOW_SHORT="true"; shift ;;
    --annotate) ANNOTATIONS="${ANNOTATIONS}${2:-}
"; shift 2 ;;
    *) printf '%s\n' "bench/mem.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

# The project's known process set. 'aibr-router' does not exist until M7.1 and
# is expected to be reported absent rather than to fail the run; the mesh TUI is
# interactive and normally absent on a capture host. opencode-serve is listed
# because it is a real resident cost of the topology even though ADR 0008
# section 2.1 excludes it from the three-process total -- it is reported, never
# summed into the headline.
if [ "$USE_ALL" = "true" ]; then
  PID_LIST="aibr-router|aibr-router,aibr-worker|aibr worker|aibr serve|aibridge-dev,aibr-tui|aibr tui|aibr-tui,opencode-serve|opencode serve"
fi

if [ -z "$PID_LIST" ]; then
  printf '%s\n' "bench/mem.sh: --pid or --all is required" >&2
  exit 2
fi
if [ -z "$INTERVAL" ]; then INTERVAL=1; fi
if [ -n "$DURATION" ]; then
  if [ -n "$SAMPLES" ]; then
    printf '%s\n' "bench/mem.sh: --samples and --duration are mutually exclusive" >&2
    exit 2
  fi
  SAMPLES=$(awk -v d="$DURATION" -v i="$INTERVAL" 'BEGIN { n = int(d / i); if (n < 1) n = 1; print n }')
fi
if [ -z "$SAMPLES" ]; then SAMPLES="$BENCH_MIN_SAMPLES"; fi

if ! printf '%s' "$INTERVAL" | grep -Eq '^[0-9]+(\.[0-9]+)?$'; then
  printf '%s\n' "bench/mem.sh: --interval must be a positive number of seconds, got '$INTERVAL'" >&2
  exit 2
fi
if ! printf '%s' "$SAMPLES" | grep -Eq '^[0-9]+$'; then
  printf '%s\n' "bench/mem.sh: --samples must be a positive integer, got '$SAMPLES'" >&2
  exit 2
fi
if [ -n "$BASELINE" ] && [ ! -f "$BASELINE" ]; then
  printf '%s\n' "bench/mem.sh: baseline file not found: $BASELINE" >&2
  exit 1
fi

bench_enforce_sampling "$INTERVAL" "$SAMPLES" "$ALLOW_SHORT" || exit 2

# shellcheck disable=SC2034
BENCH_INTERVAL="$INTERVAL"
# shellcheck disable=SC2034
BENCH_SAMPLES="$SAMPLES"
# Reconstructed rather than "${ALLOW_SHORT:+ ...}": that expansion tests for
# non-emptiness, and "false" is non-empty, so it would record --allow-short on
# every compliant run. A recorded field that misstates the run is worse than no
# field, since it is what a reviewer trusts when the terminal output is gone.
BENCH_COMMAND_LINE="bench/mem.sh --samples $SAMPLES --interval $INTERVAL --pid $PID_LIST"
if [ -n "$BASELINE" ]; then BENCH_COMMAND_LINE="$BENCH_COMMAND_LINE --baseline $BASELINE"; fi
if [ -n "$OUT" ]; then BENCH_COMMAND_LINE="$BENCH_COMMAND_LINE --out $OUT"; fi
if [ "$ALLOW_SHORT" = "true" ]; then BENCH_COMMAND_LINE="$BENCH_COMMAND_LINE --allow-short"; fi

# An annotation value becomes a JSON string in the artefact. Rejecting a double
# quote or a backslash here keeps a hand-written --annotate from producing a file
# that no longer parses, which would be silently unhelpful at gate time.
if printf '%s' "$ANNOTATIONS" | grep -q '["\\]'; then
  printf '%s\n' "bench/mem.sh: --annotate values must not contain double quotes or backslashes" >&2
  exit 2
fi

WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/aibr-bench-mem.XXXXXX")
trap 'rm -rf "$WORKDIR"' EXIT

# "," separates slots for the CLI; ";" separates slots for the resolver.
MATCHERS=$(printf '%s' "$PID_LIST" | tr ',' ';')

bench_sample_series "$WORKDIR" "$INTERVAL" "$SAMPLES" "$MATCHERS"

ticks=$(wc -l < "$WORKDIR/ticks" | tr -d ' ')
if [ "$ticks" -ne "$SAMPLES" ]; then
  printf '%s\n' "bench/mem.sh: expected $SAMPLES ticks, observed $ticks; refusing to emit a summary over a truncated run" >&2
  exit 1
fi

printf '%s\n' "sampling $SAMPLES ticks at ${INTERVAL}s: absolute RSS levels in MiB (ps -o rss=, KiB, /1024)" >&2
printf '%s\n' "" >&2

COMPARE_RC=0
bench_emit_json "$WORKDIR" "$ANNOTATIONS" "$BASELINE" > "$WORKDIR/output.json" || COMPARE_RC=$?

bench_print_summary "$WORKDIR" >&2
printf '\n' >&2

if [ -n "$OUT" ]; then cp "$WORKDIR/output.json" "$OUT"; fi

if [ "$COMPARE_RC" -ne 0 ]; then
  printf '%s\n' "bench/mem.sh: comparison against $BASELINE was not a pass (regression or inconclusive)" >&2
  exit 3
fi
exit 0
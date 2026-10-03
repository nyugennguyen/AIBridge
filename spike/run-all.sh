#!/usr/bin/env bash
# SPIKE CODE -- NOT PRODUCTION. M7.1. The whole measurement, start to finish.
#
#   bash spike/run-all.sh
#
# Strictly sequential by design. Three captures overlapping on eight CPUs would
# contend for the same cores and the levels would measure each other, which is
# the failure mode this milestone already got once.
#
# §5.1.1 A2 requires >=3 captures per quantity; A3 requires the run-to-run spread
# of the per-capture medians to be <=10%. summarise.py computes both and states
# the verdict per quantity, including `not-gateable` where A3 fails.

set -euo pipefail

SPIKE_DIR=$(cd "$(dirname "$0")" && pwd)
RESULTS="$SPIKE_DIR/results"
REPEATS=3

while [ $# -gt 0 ]; do
  case "$1" in
    --repeats) REPEATS="${2:-}"; shift 2 ;;
    *) printf 'spike/run-all.sh: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

mkdir -p "$RESULTS"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'spike/run-all.sh: %s, %s captures per topology\n' "$started" "$REPEATS" >&2

# A, then B, then C, with no pause between topologies. A4 requires one host, one
# boot and one protocol for every capture in a comparison, and a long idle gap
# between the baseline and the candidate is exactly the variable that lets host
# memory pressure become a topology effect.
for topology in A B C; do
  for run in $(seq 1 "$REPEATS"); do
    out="$RESULTS/topology-$topology-run$run.json"
    printf '\n=== spike/run-all.sh: topology %s, capture %s of %s ===\n' "$topology" "$run" "$REPEATS" >&2
    "$SPIKE_DIR/run-capture.sh" --topology "$topology" --out "$out" \
      --label "topology=$topology run=$run of $REPEATS" || {
        printf 'spike/run-all.sh: capture %s/%s for topology %s FAILED; not silently skipped\n' \
          "$run" "$REPEATS" "$topology" >&2
        exit 1
      }
  done
done

python3 "$SPIKE_DIR/summarise.py" --results "$RESULTS" --out "$RESULTS/summary.json" \
  --started "$started" --repeats "$REPEATS"

printf '\nspike/run-all.sh: done; see %s\n' "$RESULTS/summary.json" >&2
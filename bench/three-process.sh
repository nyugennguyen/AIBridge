#!/usr/bin/env bash
# bench/three-process.sh -- the honest-reporting RSS wrapper.
#
# ADR 0008 section 2.1's topology is three processes: aibr-router, aibr worker
# and aibr tui. The headline claim of this milestone is a reduction in TOTAL
# resident memory, so the SUM is the primary number here and every per-process
# figure is secondary. Quoting the router alone -- 1.94 MiB -- while omitting the
# ~43 MiB worker it was added to is the dishonest version of the same fact, and
# this script exists to make that version unavailable: the warning below is
# written into the JSON, not just printed, so a later report cannot lift the
# router's number out of this file without lifting the warning with it.
#
# It is also explicit about what the reduction does NOT touch: opencode serve,
# the ~20 MiB Bun runtime floor that any Bun process pays, and @opentui/core in
# the TUI.
#
# Pre-router operation is a supported case. Until M7.1 there is no aibr-router
# binary; the router slot is then reported as absent with zero observed ticks,
# the sum covers the processes that were actually alive, and the run does not
# fail. Absence is reported, never imputed as zero.
#
# Usage: bench/three-process.sh [--samples N] [--interval SECONDS] [--duration SECONDS]
#                              [--baseline FILE] [--out FILE] [--allow-short]
#
# EXIT CODES: as bench/mem.sh (0 ok, 1 runtime, 2 usage/refusal, 3 not-a-pass)

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# Alternatives are ordered so that the comm name wins when it exists and the argv
# substring is the fallback. `aibridge-dev` matches `bun run dev`, which is the
# documented way to run the bridge; `src/index.ts` covers a direct
# `bun src/index.ts`, which is what an ad-hoc capture tends to use.
THREE_PROCESS_SLOTS="aibr-router|aibr-router|aibr/target/release/aibr-router,aibr-worker|aibr worker|aibr serve|src/index.ts|aibridge-dev,aibr-tui|aibr tui|aibr-tui"

HEADLINE_WARNING="router-only figures are not a host-level result; opencode serve, the ~20 MiB Bun runtime floor, and @opentui/core are untouched. The primary number is the per-tick SUM across the processes that were alive; per-process figures are secondary."

MEM_ARGS=(--pid "$THREE_PROCESS_SLOTS"
  --annotate "headlineWarning=$HEADLINE_WARNING"
  --annotate "primaryMetric=sum.rssMib.median (MiB, absolute level)"
  --annotate "secondaryMetrics=processes[*].rssMib.median (MiB, absolute levels)"
  --annotate "routerAbsent=true means the aibr-router binary does not exist yet; the sum then covers only the processes that were alive")

printf '%s\n' "three-process measurement: the SUM is the primary number. Per-process figures below are secondary." >&2
printf '%s\n' "" >&2

"$SCRIPT_DIR/mem.sh" "${MEM_ARGS[@]}" "$@"
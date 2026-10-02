#!/usr/bin/env bash
# bench/imports-probe.sh -- the ADR 0008 section 1 import ladder, as levels.
#
# ADR 0008 section 1 attributes the bridge's resident memory to its MODULE GRAPH,
# not to a socket: it measured a Bun process floor, then fastify, zod, the
# opencode SDK, a config parse, route registration, a job-store write and finally
# app.listen(). This script reproduces that ladder so the attribution can be
# re-checked when the router lands.
#
# WHAT IS DIFFERENT FROM THE ADR, AND WHY:
#   The ADR table has a "Delta" column. This script computes no delta, ever. The
#   same ADR section that publishes the ladder also states that RSS deltas over a
#   short window on Bun are not evidence, because RSS FELL 4.4 MiB across 500
#   requests. A difference between two short samples is exactly that shape of
#   number. Each row here is therefore a LEVEL, summarised as median and p95 over
#   REPEATS independent fresh processes, so the figure is a distribution of
#   levels rather than a difference between two of them.
#
# Each repeat is a separate `bun` process that performs one step and then reads
# its own RSS from the kernel, so no step inherits another step's module graph.
# The repeats are what make a level a distribution: one process per step is one
# sample, with no spread and therefore no p95.
#
# This is NOT the steady-state measurement and is not the gate baseline. The gate
# baseline is the >=1 Hz for >=60 s capture from bench/mem.sh, recorded in
# bench/baseline/engines.json. This ladder attributes a LEVEL to a module; it
# does not measure an idle running system.
#
# Usage: bench/imports-probe.sh [--repeats N] [--out FILE]
# Exit:  0 = every step produced samples; 2 = usage error

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/stats.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/stats.sh"

REPEATS=7
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repeats) REPEATS="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    *) printf '%s\n' "bench/imports-probe.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
if ! printf '%s' "$REPEATS" | grep -Eq '^[0-9]+$' || [ "$REPEATS" -lt 1 ]; then
  printf '%s\n' "bench/imports-probe.sh: --repeats must be a positive integer" >&2
  exit 2
fi

WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/aibr-bench-probe.XXXXXX")
trap 'rm -rf "$WORKDIR"' EXIT

# run_step STEP_ID LABEL JS_BODY
# JS_BODY is evaluated inside a fresh bun process, awaited, and followed by a
# reading of this process's own RSS in MiB. The step's floor reading is recorded
# alongside it purely so a reader can see that a step's level is not being
# confused with a step's contribution; nothing here subtracts the two.
run_step() {
  local step_id="$1" label="$2" body="$3"
  local repeat out
  : > "$WORKDIR/$step_id.jsonl"
  repeat=0
  while [ "$repeat" -lt "$REPEATS" ]; do
    repeat=$((repeat + 1))
    out=$(PROBE_STEP_BODY="$body" PROBE_DIR="$WORKDIR" bun -e '
      const { execSync } = require("node:child_process");
      const rssMib = () => Number(execSync("ps -o rss= -p " + process.pid).toString().trim()) / 1024;
      const floor = rssMib();
      const run = new Function("return (async () => {" + process.env.PROBE_STEP_BODY + "})()");
      await run();
      console.log(JSON.stringify({ floor: floor, level: rssMib() }));
    ' 2>"$WORKDIR/$step_id.err") || true
    if printf '%s' "$out" | grep -q '"level"'; then
      printf '%s\n' "$out" >> "$WORKDIR/$step_id.jsonl"
    fi
  done
  # A step whose probe threw produces no samples; grep then exits non-zero, which
  # under `set -e` would abort the whole ladder and hide every later step.
  grep -o '"level":[0-9.]*' "$WORKDIR/$step_id.jsonl" | cut -d: -f2 > "$WORKDIR/$step_id.series" || true
  printf '  %-44s n=%s of %s requested\n' "$label" \
    "$(stats_compute < "$WORKDIR/$step_id.series" | stats_get n)" "$REPEATS"
}

printf '%s\n' "ADR 0008 section 1 import ladder, measured as LEVELS over $REPEATS fresh processes per step."
printf '%s\n' "No deltas are computed or reported; see bench/README.md." >&2
printf '%s\n' "" >&2

run_step floor "Bun process floor" ''
run_step fastify "import fastify" 'await import("fastify");'
run_step zod "import zod" 'await import("zod");'
run_step sdk "import @opencode-ai/sdk/v2" 'await import("@opencode-ai/sdk/v2");'
run_step config "Zod parse of a full config.json" '
  const { loadConfig } = await import("./src/config/loader.ts");
  await loadConfig("./config/dev-main.example.json");
'
# A real config, not a stub: registerTriggerRoute reads
# config.planning.require_approval_for while registering, so an empty object
# fails before a single route is added and the step would report a level for a
# module graph the running bridge never builds.
run_step routes "src/server/app.ts routes" '
  const { loadConfig } = await import("./src/config/loader.ts");
  const { createApp } = await import("./src/server/app.ts");
  createApp({
    config: await loadConfig("./config/dev-main.example.json"),
    bearerToken: "probe",
    jobManager: { getJob: async () => undefined, listJobs: async () => [] },
    opencodeClient: { health: async () => ({}), trigger: async () => ({}), report: async () => ({}) },
    callbackReporter: { report: async () => ({}) },
    monitorSession: async () => {},
    taskGraphSyncer: { sync: async () => ({}) }
  });
'
run_step jobstore "JsonFileJobStore first write" '
  const { JsonFileJobStore } = await import("./src/jobs/store.ts");
  const store = new JsonFileJobStore(process.env.PROBE_DIR + "/jobs");
  await store.save({ job_id: "probe", source_agent_id: "probe", target_agent_id: "probe", trigger: {}, status: "received" });
'
run_step listen "app.listen()" '
  const Fastify = (await import("fastify")).default;
  const app = Fastify();
  await app.listen({ host: "127.0.0.1", port: 0 });
  await app.close();
'

# --- JSON -----------------------------------------------------------------
# shape: aibridge.bench.imports/1. Documented in bench/README.md alongside the
# aibridge.bench.mem/1 schema in bench/baseline/schema.json.
{
  printf '{\n'
  printf '  "schema": "aibridge.bench.imports/1",\n'
  printf '  "generatedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "host": { "os": "%s", "arch": "%s", "bun": "%s" },\n' \
    "$(uname -s)" "$(uname -m)" "$(bun --version)"
  printf '  "method": "one step per fresh bun process, process RSS read from the kernel after the step, %s repeats per step",\n' "$REPEATS"
  printf '  "quantity": "absolute RSS level in MiB; no delta is computed or implied",\n'
  printf '  "notAIdleSteadyStateMeasurement": true,\n'
  # Explicit step order, not glob order: a ladder whose rows come out in
# alphabetical order reads like an unordered list of modules.
  STEPS="floor fastify zod sdk config routes jobstore listen"
  printf '  "steps": {\n'
  first_step=1
  for step_id in $STEPS; do
    step_file="$WORKDIR/$step_id.series"
    [ -f "$step_file" ] || continue
    if [ "$first_step" -eq 0 ]; then printf ',\n'; fi
    first_step=0
    printf '    "%s": {' "$step_id"
    n=$(stats_compute < "$step_file" | stats_get n)
    if [ "${n:-0}" -eq 0 ]; then
      # A step that produced nothing is reported as a failure with the probe's
      # own error, never as a level of zero. A zero here would be read as "this
      # module costs nothing", which is the opposite of what a failure means.
      printf ' "samples": [], "levelMib": null, "error": %s }' \
        "$(printf '"%s"' "$(head -1 "$WORKDIR/$step_id.err" 2>/dev/null | cut -c1-160 | sed 's/["\\]//g')")"
      continue
    fi
    case "$step_id" in
      floor) step_label="Bun process floor" ;;
      fastify) step_label="import fastify" ;;
      zod) step_label="import zod" ;;
      sdk) step_label="import @opencode-ai/sdk/v2" ;;
      config) step_label="Zod parse of a full config.json" ;;
      routes) step_label="src/server/app.ts routes" ;;
      jobstore) step_label="JsonFileJobStore first write" ;;
      listen) step_label="app.listen()" ;;
      *) step_label="$step_id" ;;
    esac
    printf '\n      "label": %s,\n' "$(printf '"%s"' "$step_label")"
    printf '      "levelMib": {'
    stats_compute < "$step_file" | stats_json | sed '1d;$d' | sed 's/^ */       /'
    printf ' },\n'
    printf '      "samples": ['
    awk 'NR == 1 { printf "%s", $0; next } { printf ", %s", $0 }' "$step_file"
    printf ']\n    }'
  done
  printf '\n  }\n}\n'
} > "$WORKDIR/output.json"

if [ -n "$OUT" ]; then cp "$WORKDIR/output.json" "$OUT"; fi

if [ -f "$WORKDIR/output.json" ]; then
  cat "$WORKDIR/output.json"
fi
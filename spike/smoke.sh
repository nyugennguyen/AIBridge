#!/usr/bin/env bash
# SPIKE CODE -- NOT PRODUCTION. M7.1 smoke check.
#
# Proves every moving part comes up before a 60 s measurement is attempted,
# because a capture whose router never bound produces an artefact whose router
# row is "absent" -- which the harness reports faithfully and a reader would
# mistake for the router being cheap.
#
# Usage: spike/smoke.sh

set -euo pipefail

SPIKE_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SPIKE_DIR/.." && pwd)
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/aibr-spike-smoke.XXXXXX")
fail=0

# shellcheck disable=SC2329  # invoked by the EXIT trap installed below
cleanup() {
  for pid in ${PIDS:-}; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORKDIR"
}
PIDS=""
trap cleanup EXIT

mkdir -p "$WORKDIR/state"
export AIBRIDGE_CONFIG="$REPO_ROOT/bench/baseline/capture-config.json"
export AIBRIDGE_BEARER_TOKEN=spike-not-a-secret
export OPENCODE_SERVER_PASSWORD=spike-not-a-secret
export SPIKE_STATE_DIR="$WORKDIR/state"
export SPIKE_LOAD_PROFILE="$SPIKE_DIR/load-profile.json"

check() {
  if [ "$1" = "0" ]; then printf '  OK   %s\n' "$2"; else printf '  FAIL %s\n' "$2"; fail=1; fi
}

# expect_code PORT METHOD PATH EXPECTED LABEL -- the status is captured first and
# judged afterwards, so shellcheck never sees a `$?` that refers to a condition
# rather than a command.
expect_code() {
  local port="$1" method="$2" path="$3" expected="$4" label="$5" got
  got=$(curl -s -o /dev/null -m 5 -w '%{http_code}' -X "$method" "http://127.0.0.1:$port$path" \
    -H 'content-type: application/json' --data-binary '{"hello":"spike"}' || printf '000')
  if [ "$got" = "$expected" ]; then check 0 "$label"; else check 1 "$label (got $got, wanted $expected)"; fi
}

printf 'spike/smoke.sh: 1. the worker import closure contains no fastify\n'
bash "$SPIKE_DIR/check-no-fastify.sh" "$SPIKE_DIR/worker-no-fastify.ts" > "$WORKDIR/scan.log" 2>&1
check "$?" "spike/check-no-fastify.sh"

printf 'spike/smoke.sh: 2. the router stub is still a measurement stub and has grown no durability\n'
# A stub that picked up sqlx would measure a floor the real router will not sit
# near, in the direction that flatters the milestone. The omission is the point,
# so it is asserted rather than left to review.
# `cargo tree`, not a grep over the sources: the assertion is about what was
# actually resolved into the binary, and a grep over Cargo.toml matches the
# header comment that explains at length why there is deliberately no sqlx. A
# check that can only fail by reading its own rationale is not a check.
if ( cd "$SPIKE_DIR/router-stub" && cargo tree --prefix none --depth 1 2>/dev/null ) \
  | grep -Eqi '^(sqlx|rusqlite|libsqlite3|tokio-postgres) '; then
  check 1 "the stub's resolved dependency graph contains a database; it is supposed to be a memory floor only"
else
  check 0 "no sqlx/sqlite/postgres in the stub's resolved dependency graph"
fi
if grep -Eq 'axum = \{ version = "0\.8"|tokio = \{ version = "1"' "$SPIKE_DIR/router-stub/Cargo.toml"; then
  check 1 "a Rust dependency version floats; ADR 0008's convention is exact pins"
else
  check 0 "axum and tokio are pinned to exact versions"
fi

printf 'spike/smoke.sh: 3. the router stub serves GET /health 200 and POST /trigger 202 on an ephemeral port\n'
"$SPIKE_DIR/router-stub/target/release/aibr-router-stub" \
  --bind 127.0.0.1:0 --port-file "$WORKDIR/stub.port" > "$WORKDIR/router.log" 2>&1 &
ROUTER_PID=$!
PIDS="$ROUTER_PID"
attempt=0
while [ "$attempt" -lt 40 ] && [ ! -s "$WORKDIR/stub.port" ]; do
  attempt=$((attempt + 1))
  kill -0 "$ROUTER_PID" 2>/dev/null || break
  sleep 0.25
done
STUB_PORT=$(cat "$WORKDIR/stub.port" 2>/dev/null || true)
# Captured through `||` rather than read off the next line's `$?`: under
# errexit the assignment never runs if the test is a bare failing command.
ephemeral=no
if [ -n "$STUB_PORT" ] && [ "$STUB_PORT" != "0" ]; then ephemeral=yes; fi
if [ "$ephemeral" = "yes" ]; then
  check 0 "the stub bound a kernel-assigned ephemeral port (got '$STUB_PORT')"
else
  check 1 "the stub bound a kernel-assigned ephemeral port (got '${STUB_PORT:-none}')"
fi
expect_code "$STUB_PORT" GET /health 200 "GET /health -> 200"
expect_code "$STUB_PORT" POST /trigger 202 "POST /trigger -> 202"
# Deliberately asserts a 404, not an absence of a check: if the stub ever grows a
# GET /jobs/:id it will start looking like the router ADR 0008 §6 says owns that
# route, and a reader of this spike could mistake it for M7.3's work.
expect_code "$STUB_PORT" GET /jobs/x 404 "GET /jobs/:id is 404 -- the stub implements no router routes"
grep -q 'MEASUREMENT STUB, NOT aibr-router' "$WORKDIR/router.log"
check "$?" "the stub identifies itself as non-production on startup"

printf 'spike/smoke.sh: 4. the worker starts with no fastify and no listener\n'
( cd "$REPO_ROOT" && exec bun "$SPIKE_DIR/worker-no-fastify.ts" ) > "$WORKDIR/worker.log" 2>&1 &
WORKER_PID=$!
PIDS="$WORKER_PID $PIDS"
sleep 6
grep -q 'spike topology B/C ready' "$WORKDIR/worker.log"
check "$?" "worker reported ready"
# The decisive assertion: a worker that opened a listening socket would have
# failed to bind 127.0.0.1:8787, which is Fastify's configured port and is free
# here but is what the engine would try first. The stronger, permanent statement
# is check 1 plus this one together: the worker's closure has no server framework
# and the process comes up alongside an unrelated listener without competing.
kill -0 "$WORKER_PID" 2>/dev/null
check "$?" "worker is still running alongside the stub, which holds a port"

printf 'spike/smoke.sh: 5. the load loop is actually running at the profile rate\n'
# The loop reports every 10s, so the first reading cannot exist before 10s of
# worker uptime have passed. Sampling "before" a report has been emitted would
# read empty and compare as a failure.
iterations() { sed -n 's/^spike-load iterations=\([0-9]*\).*/\1/p' "$WORKDIR/worker.log" | tail -1; }
sleep 12
first=$(iterations)
first=${first:-0}
sleep 11
second=$(iterations)
second=${second:-0}
# ~50 iterations per 10s at the profile rate of 5/s; no HTTP load is running in
# this check, so the window is 5/s in-process only.
[ "$second" -gt "$first" ] && [ $((second - first)) -gt 40 ]
check "$?" "load loop advanced at roughly the profile rate ($first -> $second in ~10s; 5/s implies ~50)"
grep -q 'failures=0' "$WORKDIR/worker.log"
check "$?" "the load loop reported zero failed iterations (it is doing work, not rejecting)"

# Steps 6 and 7 are ordered by what needs to be alive. three-process.sh can only
# prove it CANNOT resolve the spike worker while a router stub is actually
# resident -- the assertion is about the asymmetry between the two slots, so an
# empty slot list proves nothing. Step 7 then needs the stub GONE, because a
# leftover stub is a second match in the capture's own slot.
printf 'spike/smoke.sh: 6. bench/three-process.sh CANNOT resolve the spike worker\n'
bash "$REPO_ROOT/bench/three-process.sh" --duration 3 --allow-short \
  --out "$WORKDIR/tp.json" >/dev/null 2>&1 || true
python3 - "$WORKDIR/tp.json" <<'PY'
import json, sys
document = json.load(open(sys.argv[1]))
processes = document.get("processes") or {}
seen = {name: (value or {}).get("absentTicks") for name, value in processes.items()}
print("  slots (absentTicks of 3):", json.dumps(seen))

# The router stub DOES resolve into three-process.sh's `aibr-router` slot, because
# that slot's argv alternative is the substring `aibr-router` and the stub's argv
# contains `aibr-router-stub`. The worker does NOT: the slot's alternatives are
# `aibr worker`, `aibr serve`, `src/index.ts` and `aibridge-dev`, and a process
# started as `bun spike/worker-no-fastify.ts` matches none of them.
#
# That asymmetry is why spike/run-capture.sh calls bench/mem.sh with an explicit
# --pid list instead. Using three-process.sh here would produce a SUM containing
# the 2 MiB stub and omitting the ~45 MiB worker -- which is precisely the
# dishonest headline that bench/three-process.sh exists to make unavailable. The
# harness would report it faithfully, because it reports absence rather than
# imputing zero, which is why this is asserted rather than assumed.
router = seen.get("aibr-router")
worker = seen.get("aibr-worker")
ok = router == 0 and worker == 3
if not ok:
    print(f"  expected aibr-router resolved (0 absent) and aibr-worker absent (3 absent); got {router}/{worker}")
sys.exit(0 if ok else 1)
PY
check "$?" "three-process.sh omits the spike worker from its SUM (documented deviation)"
printf 'spike/smoke.sh: 7. a capture'"'"'s slots resolve to distinct processes, one per topology\n'
# The worker from step 4 AND the stub from step 3 must be stopped first, and both
# are a real trap rather than tidiness: they run the SAME argv as the capture's
# own worker and stub, so a leftover is a second match and the slot reports two
# pids. This happened for real -- smoke left its stub alive and the capture's
# `spike-router-stub` slot resolved to two pids, one of them an orphan from the
# previous step. A slot that matches a stranger is still summed, so the capture
# would have measured 3 processes for a 2-process topology and reported it.
kill "$ROUTER_PID" 2>/dev/null || true
wait "$ROUTER_PID" 2>/dev/null || true
kill "$WORKER_PID" 2>/dev/null || true
wait "$WORKER_PID" 2>/dev/null || true
sleep 1
# The bug this asserts against actually happened: the first topology A capture
# declared two slots (`spike-worker|<entrypoint>` and `spike-engine|<entrypoint>`)
# that both matched the same process, and reported a 124.6 MiB SUM for a 62.3 MiB
# engine. bench/mem.sh reports whatever slots it is given, so the only defence is
# to check, and checking means asserting the negative case still fails.
bash "$SPIKE_DIR/run-capture.sh" --topology B --out "$WORKDIR/b.json" --label "smoke topology B" \
  > "$WORKDIR/b.log" 2>&1
check "$?" "a topology B capture completes"
python3 - "$WORKDIR/b.json" <<'PY'
import json, sys
document = json.load(open(sys.argv[1]))
processes = document.get("processes") or {}
present = {n: (v.get("pids") or []) for n, v in processes.items() if not v.get("absentTicks")}
all_pids = [pid for pids in present.values() for pid in pids]
print("  present slots:", json.dumps(present))
ok = len(all_pids) == len(set(all_pids)) == 2
if not ok:
    print(f"  expected 2 distinct pids, got {all_pids}")
sys.exit(0 if ok else 1)
PY
check "$?" "topology B resolves exactly 2 distinct processes (router + Bun), no double count"


printf '\n'
if [ "$fail" -eq 0 ]; then
  printf 'spike/smoke.sh: all checks passed\n'
else
  printf 'spike/smoke.sh: FAILURES above\n'
fi
exit "$fail"
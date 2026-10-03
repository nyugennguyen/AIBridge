# spike/ — M7.1 measurement spike, NOT production code

Everything in this directory is a throwaway measurement artefact. It exists to
answer one question that ADR 0008 §2.1 answered with arithmetic instead of a
measurement, and to compare three topologies under a protocol that can tell them
apart.

**Nothing here may be imported from `src/`, promoted to `router/`, or treated as
a starting point for M7.3.** `spike/router-stub/` is a two-route memory floor, not
`aibr-router`. It implements no structural validation, no bearer comparison, no
`realpath` containment, no `schemaVersion` refusal, no body cap, no SQLite and no
outbox policy — all of those are M7.3/M7.5/M7.6, and inventing them here would
produce a component that *looks* like a security boundary and is not one.

## The question

ADR 0008 §2.1 projects a **43.3 MiB** worker (the 57.3 MiB engine minus Fastify's
31.2 MiB) and a **−39%** three-process reduction. Milestone 7 §5.2 makes
worker-without-Fastify ≤ 48 MiB an acceptance criterion. §11 of the ADR already
admits the number is "a projection, not a measurement".

`spike/worker-no-fastify.ts` is that measurement: the engine's module graph
assembled without `fastify` and without a listening socket.

## Running it

```sh
(cd spike/router-stub && cargo build --release)   # ~590 KiB stub binary
bash spike/smoke.sh                              # every moving part, ~35 s
bash spike/run-all.sh                            # the measurement, ~20 min
# per-capture JSON and the rollup land in spike/results/
bunx tsc -p spike/tsconfig.json                  # the spike is typechecked
bash spike/check-no-fastify.sh spike/worker-no-fastify.ts
```

`spike/run-all.sh --repeats N` changes the capture count. Do not change it
between the topologies in one comparison: §5.1.1 A4 requires the same protocol
for every capture in a comparison.

## The four things here

| File | What it is |
| --- | --- |
| `worker-no-fastify.ts` | **the deliverable.** The engine without Fastify. Its import closure is asserted by `check-no-fastify.sh`. |
| `engine-with-fastify.ts` | topology A: calls the real `startBridge()` unchanged, listens with Fastify, same load loop. |
| `load-loop.ts` | the fixed-rate in-process work loop. Runs identically in all three topologies so the A-vs-B difference is one variable. |
| `router-stub/` | two axum routes, a tokio runtime, no persistence. A memory **floor**, not an estimate of the real router. |
| `run-capture.sh` | one capture. Starts the topology, warms, loads, samples, **and refuses the capture if its slots double-count a process**. |
| `summarise.py` | the rollup. Applies §5.1.1 A2/A3, and refuses to roll up overlapping captures. |
| `smoke.sh` | 16 assertions that every moving part works, run before any measurement. |

## Protocol deviations, stated up front

These are the places this spike does not do what the plan says. Each is a
finding, not a convenience.

1. **The committed load profile does not exist.** Milestone 7 §5.1.1 says "the
   load profile is fixed in `bench/baseline/capture-config.json`". That file is a
   bridge configuration — `agent_id`, `bridge`, `opencode`, `security`,
   `permissions`, `projects`, `agents`, `timeouts`, `planning` — and contains no
   rate, no request mix and no payload. The profile is declared in
   `load-profile.json` here instead, applied identically to every topology, and
   the gap is reported.
2. **`bench/three-process.sh` cannot resolve these processes.** Its slots match
   `src/index.ts`, `aibr serve`, `aibridge-dev`, `aibr-router` and `aibr tui`.
   A process started as `bun spike/worker-no-fastify.ts` matches none of them, so
   `run-capture.sh` passes an explicit `--pid` list to `bench/mem.sh` instead,
   with the same slot layout and the same annotations. `smoke.sh` check 7 asserts
   this rather than assuming it: using `three-process.sh` would have put the 2 MiB
   stub in the SUM and left the ~48 MiB worker out of it — the exact dishonest
   headline that script exists to prevent.
3. **The load loop does not stop at the opencode health probe.** No `opencode
   serve` runs on this host, so every iteration would terminate at the same
   `ECONNREFUSED` with no durable write. The loop continues past the probe into
   the job store so it measures drain work rather than rejection handling.
4. **The JetStream stream is created over the API, not declared in config.**
   `nats-server` v2.15.0 rejects a `streams {}` block (`unknown field "streams"`)
   and this host has no `nats` CLI. `router-stub/src/main.rs` sends
   `$JS.API.STREAM.CREATE` instead.

## The bug this spike hit, and the checks that now catch it

The first topology A capture reported a **124.6 MiB SUM for a 62.3 MiB engine**.
The slot list declared both `spike-worker|<entrypoint>` and
`spike-engine|engine-with-fastify.ts`; under topology A both argv alternatives
matched the *same* process and it was summed twice.

`bench/mem.sh` reported this faithfully — it resolves the slots it is given, and
it is not in a position to know that two slots were meant to be one process. This
is the exact failure the harness exists to make hard to hide, and it was still easy
to hide: nothing printed a warning, and the per-process rows looked plausible
side by side.

Three defences now exist, all of which are checks rather than intentions:

1. `run-capture.sh` declares **one slot per process that can exist in the
   topology**, and after sampling reads the resolved pid set back out of the
   artefact and **exits nonzero** if any pid appears in two slots, or if fewer
   distinct processes were resolved than the topology requires.
2. `summarise.py` **refuses to roll up** any capture whose slots overlap, and
   reports the per-capture distinct-process count against the expected count.
3. `smoke.sh` check 7 runs a real capture and asserts the pids are distinct —
   which had to include killing the `smoke.sh`-step-5 worker first, because it
   runs the same argv and was itself a second match.

The lesson generalises past this spike: **a slot list is an assertion about which
processes exist, and nothing in the sampling loop can check it.** Any future
capture with hand-written matchers needs the same check.

## What this spike is not

Not a soak. Not a rollout. Not a multi-day result. One host, one session, a
60-second sampling window. It also does not start `opencode serve`, so no
admission latency figure and no end-to-end webhook-to-engine figure comes out of
it. The TUI is absent, as it is in `bench/baseline/engines.json`.

The router's numbers here are a **lower bound**. The real router will add SQLite,
sqlx, a pool, constant-time bearer comparison, `realpath` containment and the
outbox policy. Nothing in this directory measures any of that.
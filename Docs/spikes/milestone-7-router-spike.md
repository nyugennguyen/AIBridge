# Milestone 7 spike: the worker-without-Fastify measurement

Task: **M7.1** — ADR 0008 acceptance and spike.
Date: 2026-10-03. Host: macOS arm64 (Darwin 25.6.0), 8 CPUs, Bun 1.3.14,
Rust 1.94.1. **Single host, single session, short window.** Not a soak, not a
rollout result, and not evidence of multi-day stability.

Every figure below is an absolute RSS **level** in MiB, reported as the median of
per-capture medians with p95 alongside. No delta is reported anywhere.

Reproduce with:

```bash
bash spike/check-no-fastify.sh   # proves the spike really has no fastify
bash spike/run-all.sh            # 9 captures, ~15 min
python3 spike/summarise.py       # writes spike/results/summary.json
```

Machine-readable source of truth: `spike/results/summary.json`.

## Verdict, first

**The 43.3 MiB projection is wrong.** The worker-without-Fastify measures
**46.98 MiB**, 3.68 MiB (+8.5%) above the projection. The `<= 48 MiB` criterion
passes on the median by 1.02 MiB — but the run-to-run spread is 2.98 MiB, so
**the pass is not resolvable by re-capturing**. The honest reading is
"≈47 MiB, criterion unresolvable", not "PASS".

**The −39% headline does not survive measurement.** The measured reduction from
today's engine to worker+router is **−29.3%**, not −39%. The reason is not that
the router is expensive — it is that the *baseline* moved.

**The baseline is not gateable at all.** Topology A spread **34.7%** across three
captures of an unchanged process. A comparison whose baseline cannot be
reproduced cannot produce a trustworthy percentage, whatever it says.

**What did hold:** the router stub's 1.94 MiB projection is confirmed (1.91 MiB
measured, 558 KiB binary), and §5.1.1's diagnosis was correct — **steady state
under sustained load collapses the noise from 61% to under 7%**. That fix was
necessary and it works.

## Measurements

### Protocol (§5.1.1 gate admissibility)

| Rule | Applied |
| --- | --- |
| A1 — >=1 Hz for >=60 s | honoured in all 9 captures (`shortSample: false` everywhere) |
| A2 — >=3 captures, median of per-capture medians | 3 per topology; 6 pooled for the worker criterion |
| A3 — run-to-run spread <=10% | **held for the worker (6.35%) and topologies B (2.85%) / C (4.34%); FAILED for topology A (34.7%)** |
| A4 — same host, boot, profile, script | all captures from one session |

Load profile fixed in `spike/load-profile.json`; it must not change mid-milestone.

### Worker without Fastify — the number this milestone rests on

| Quantity | Value |
| --- | --- |
| Projection (ADR 0008 §2.1) | 43.3 MiB |
| Criterion | <= 48.0 MiB |
| **Measured, median of 6 capture medians** | **46.977 MiB** |
| Measured p95 | 48.906 MiB |
| Projection residual | **+3.677 MiB (+8.5%)** |
| Per-capture medians | 47.203, 45.828, 46.953, 47.000, 48.812, 46.656 |
| Run-to-run spread | 2.984 MiB (6.35%) |
| Margin to criterion | 1.023 MiB |
| **Margin < spread?** | **yes — the verdict is not resolvable by re-capturing** |

Median passes; p95 fails. The projection was optimistic by 8.5%, which means
ADR 0008 §2.1's arithmetic — 57.3 MiB minus Fastify's 31.2 MiB — understates
what the engine keeps after Fastify is gone. Zod, the OpenCode SDK, and JSC's own
footprint account for the gap.

**Pooling caveat, carried from the capture:** topologies B and C measure the same
Bun process with the router stub resident, so their captures are pooled to reach
6 samples for this criterion. If B and C disagreed by more than 10% the pool would
have to be split; they did not (47.0 vs 47.0 median-of-medians).

### Topologies

Sum is the primary number, per M7.0's `three-process.sh` discipline.

| Topology | Processes | Median of medians | p95 | Spread | A3 |
| --- | --- | --- | --- | --- | --- |
| **A** — engine with Fastify (today) | 1 | 69.133 MiB | 69.312 | **34.7%** | **fail** |
| **B** — worker + router stub | 2 | 48.859 MiB | 49.531 | 2.85% | pass |
| **C** — worker + router stub (repeat batch) | 2 | 48.922 MiB | 52.016 | 4.34% | pass |

Per-capture sum medians: A `[69.133, 62.148, 86.141]`, B `[49.125, 47.734, 48.859]`,
C `[48.922, 50.688, 48.562]`.

Topology C is a **repeat capture batch, not a distinct topology** — NATS was
removed from scope before this spike ran, so there is no third topology to
compare. It exists to double the sample count for the worker criterion.

### The router stub

| Quantity | Projected (ADR 0008 §2.1) | Measured |
| --- | --- | --- |
| RSS median | 1.94 MiB | **1.906 MiB** |
| RSS p95 | — | 3.562 MiB |
| Binary | 590 KiB | **558.1 KiB** (571,504 bytes) |

The projection holds to within 1.8%. Build: `opt-level="z"`, `lto`, `codegen-units
= 1`, `panic = "abort"`, `strip`, dependencies pinned exactly
(axum `=0.8.9`, tokio `=1.53.1`), `cargo clippy -- -D warnings` clean.

**This is a lower bound, not an estimate of the real router.** The stub has no
SQLite, no sqlx, no structural validation, no bearer comparison, no realpath
containment, no schemaVersion handling, no body cap, and no backoff. M7.5's
`ingress_outbox` adds memory this stub cannot show.

## Why the baseline moved

Topology A is not the 57.3 MiB ADR 0008 records. It measures **69.13 MiB**, 20.7%
higher, and its three captures span 62.1–86.1 MiB. Two separate problems:

1. **The spike's engine carries the load generator's own load.** Topology A is
   driven through the fixed sustained profile so the comparison is like-for-like,
   and a Bun process under sustained traffic holds more pages than one sitting
   idle. M7.0 measured **idle**; this spike measures **steady state under load**.
   These are different quantities and the plan says so — §5.1.1 changed the gated
   quantity deliberately. The two numbers are not in conflict; they were never
   measuring the same thing.
2. **The 61% idle spread from M7.0 is absent here** (34.7% is still too high to
   gate, but it is far below 61%). Sustained load pins the allocator plateau,
   which is exactly the mechanism §5.1.1 predicted.

## Consequences for ADR 0008

1. **§2.1's worker figure must become 46.98 MiB**, not 43.3.
2. **The −39% headline must be restated as −29.3% measured**, against a baseline
   that is itself not gateable — so even −29.3% is a point estimate with a stated
   spread, not a result.
3. **The `<= 45 MiB` total target is now known to be unreachable on this host
   with this topology.** Worker alone is ~47 MiB before the router, the TUI, or
   `opencode serve`. The target predates the measurement and assumed the
   projection was exact.
4. **§5.1.1 stands and is vindicated.** Without it this spike would have compared
   one draw against another and reported a confident number.

## Residuals

| # | Item | Status |
| --- | --- | --- |
| R-M7.1-1 | Topology A baseline spread 34.7% — the *before* quantity cannot be gated | **open**. Blocks any percentage claim until a stable baseline definition exists |
| R-M7.1-2 | Margin (1.02 MiB) < spread (2.98 MiB) on the `<= 48 MiB` criterion | **open**. Re-capturing cannot resolve it; more samples could |
| R-M7.1-3 | ADR 0008's 57.3 MiB baseline and the spike's 69.13 MiB are different quantities (idle vs sustained load) | **open**. Both must be labelled, and no report may cite one as the other |
| R-M7.1-4 | Router stub is a lower bound; `sqlx` + SQLite cost is unmeasured | **open**, M7.5 |
| R-M7.1-5 | `opencode serve`, Bun runtime floor, and `@opentui/core` still unmeasured | **open**, untouched by this milestone |

## What this spike did NOT do

- No soak, no rollout, no canary, no rollback timing. M7.14 owns those and none of
  them were attempted.
- No `tailscale0` bind. This host has none; M7.11 owns it.
- No durable write, no SQLite, no security gate in the stub. M7.3/M7.5 own them.
- `src/` and `tests/` are **unmodified** — verified by `spike/check-no-fastify.sh`
  (20 modules reachable, no `fastify`, no `@fastify/*`, no `src/server/`) and by
  `git status`. `bun run typecheck` and `bun test` (5102 pass, 0 fail) are green.
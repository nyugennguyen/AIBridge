# Milestone 7: Polyglot Ingress and Durable Admission

## Objective

Replace the Bun engine's HTTP ingress with a native Rust router that owns the listening socket, authenticates and bounds every request, and admits work to a durable SQLite queue before acknowledging it. Remove Fastify from the engine process, cut resident memory by roughly 39%, and close five open High threat-model findings at the trust boundary — while leaving the engine as the sole authority for every authorization decision and leaving the TUI decoupled from the job engine.

This milestone **adds** a second programming language for one narrow component. It is authorised by [ADR 0008](../adr/0008-polyglot-ingress-and-admission.md), which also records why durable admission uses the existing SQLite outbox rather than a message broker. The language guardrail in [`README.md:77`](./README.md) is amended, not deleted.

## Execution Scope

Decided 2026-10-03, after M7.0 and M7.1. This records **what this milestone can
honestly deliver from the reference host**, so no gate report is ever written
against work that could not be run.

**In scope, fully implemented and verified here:** M7.2 (contract generation),
M7.3 (router skeleton and the four security gates), M7.4 (`ingress_mode` flag),
M7.5 (`ingress_outbox`), M7.6 (backoff port and parity), M7.7 (worker drain and
listener removal), M7.8 (`egress_outbox`, closes `F-02`), M7.12 (bound
enforcement), M7.13 (TUI decoupling assertion).

**Written but verified only by CI:** M7.9 (static build matrix), M7.10
(`systemd`/`launchd` supervisor), M7.11 (`nft` + `tailscale0` bind enforcement).
The reference host is macOS with **no `tailscale0`, no `systemd`, and no `zig`**,
so these ship as code plus a GitHub Actions workflow that executes them on Linux
runners. Each is recorded `unverified-on-macOS` with the exact command that
verifies it. Nothing here may be reported as passing until that workflow is green
on a real run.

**Not attempted at all:** M7.14 (canary rollout). It needs two live nodes and
7-day soaks. No substitute exists and none is invented.

**Consequently there is no `milestone-7-completion.md`.** A gate report for this
milestone would have to assert a total-RSS reduction, a Linux supervision
behaviour, a tailnet bind, and a multi-day soak that were never observed. The
honest artefact is a partial-progress report naming what ran and what did not.

## Prerequisites

- Milestones 0–6 have completion reports and no unresolved blocker/high security findings, **except** the five findings this milestone closes (`F-01`, `F-02`, `F-03`, `F-04`, `F-06`). Their status is a prerequisite item, not a discovery.
- ADR 0008 is accepted and signed by the `security-reviewer`. **No Rust source may be written before this.**
- The carried-forward limitations in [`milestone-4-distributed-mesh.md`](./milestone-4-distributed-mesh.md) §"Known limitations carried forward" are read and owned. **R8** in particular — `bridge.ts` is intentionally unwired so the kernel is absent at runtime — interacts with M7.4's flag default.
- Baseline measurements in ADR 0008 §1 are reproducible on the reference host before any task changes a line of production code.

## Measured Baseline

These are levels measured on macOS 26.6.2 / arm64, Bun 1.3.14, Rust 1.94.1. They are the comparison basis for every resource claim in this milestone.

| Component | RSS | Threads | Source |
| --- | --- | --- | --- |
| Bun process floor | 22.9 MiB | — | ADR 0008 §1 |
| `import fastify` | +22.7 MiB | — | ADR 0008 §1 |
| `app.listen()` | +8.5 MiB | — | ADR 0008 §1 |
| `aibr serve` end-to-end, **idle** | 57.3 MiB | 14 | ADR 0008 §1 |
| Rust + axum + tokio, 2 routes, `opt-level="z"` + LTO + strip | **1.91 MiB** (558 KiB binary) | 9 | M7.1 measured |

**The 57.3 MiB idle figure and the M7.1 steady-state figures are different
quantities.** Idle is not a reproducible level for a Bun process (§5.1 rule 3);
steady state under sustained load is. Measured under the §5.1.1 protocol:

| Topology | Median of medians | p95 | Spread | Gateable |
| --- | --- | --- | --- | --- |
| A — engine with Fastify, steady state | 69.13 MiB | 69.31 | **34.7%** | **no** |
| B — worker + router stub, steady state | 48.86 MiB | 49.53 | 2.85% | yes |
| — worker alone | **46.98 MiB** (projection was 43.3) | 48.91 | 6.35% | yes, marginal |
| — router stub alone | 1.91 MiB | 3.56 | — | lower bound |

Measured reduction **−29.3%**, not the −39% first projected. Full analysis and
residuals: [`milestone-7-router-spike.md`](../spikes/milestone-7-router-spike.md).

**The 43.3 MiB worker projection was wrong.** M7.1 measured **46.98 MiB** (+8.5%).
The old figure was ADR 0008 §1 minus Fastify, which understates what the engine
keeps — Zod, the OpenCode SDK, and JSC's own footprint survive the removal.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M7.0 Baseline capture and benchmark harness | M0–M6 | `test-engineer` — `gpt-5.6-sol high` | `bench/mem.sh`, `bench/latency.sh`, `bench/three-process.sh`; reproducible capture of the ADR 0008 §1 baseline as committed JSON | Median/p95 over >=60 s; harness demonstrably reports a *falling* RSS series as noise, not a win |
| M7.1 ADR 0008 acceptance and spike | M7.0 | `architect` + `security-reviewer` — `gpt-6-astra xhigh` | Confirm or revise ADR 0008; build the worker-without-Fastify spike and a minimal Rust router stub; **measure the 43.3 MiB projection** | Worker-without-Fastify measured at <=48 MiB under §5.1.1 A1–A4; the projection is confirmed or the −39% claim is withdrawn |
| M7.2 Contract generation chain | M7.1 | `subsystem-builder` — `gpt-5.6-sol high` | `zod-to-json-schema` -> `contracts/v1/*.schema.json` -> `typify` -> generated Rust types; generator is reproducible and committed | 15/15 `tests/contracts/examples/*.v1.json` parse identically both sides; `git diff --exit-code contracts/` clean |
| M7.3 Router skeleton and four security gates | M7.2 | `subsystem-builder` — `gpt-5.6-sol high` | `aibr-router` Cargo workspace; structural validation; constant-time bearer; `job_id` charset; `realpath` project containment; `schemaVersion` refusal; `1 MiB` body cap | `F-01`/`F-03`/`F-04`/`F-06` reproductions from the threat model all rejected at ingress |
| M7.4 `ingress_mode` flag and shadow mode | M7.3 | `feature-builder` — `gpt-5.6-terra high` | `bridge.ingress_mode: "engine" \| "router"` with `.default("engine")`; `--shadow-mode` mirroring ingress while the engine still listens | Every existing config keeps working; rollback is deleting one key; 72 h shadow divergence is zero |
| M7.5 Durable admission queue | M7.3 | `subsystem-builder` — `gpt-5.6-sol high` | `ingress_outbox` (WAL, `synchronous=FULL`); claim lease; `recoverStale`; `ON CONFLICT DO NOTHING`; versioned migration; corrupt-data handling | 1000 kill/restart cycles, zero loss; zero duplicate executions; store deletion exits `78`, no in-memory fallback |
| M7.6 Backoff policy port and parity | M7.5 | `test-engineer` — `gpt-5.6-sol high` | Rust port of `DELIVERY_BACKOFF_MS`, `MESH_OUTBOX_MAX_ATTEMPTS`, `MESH_OUTBOX_CLAIM_LEASE_MS`; retained terminal rows; documented full-jitter deviation | 16/16 golden vectors agree with the TypeScript implementation |
| M7.7 Worker drain loop and listener removal | M7.5, M7.6 | `subsystem-builder` — `gpt-5.6-sol high` | Worker polls `nextWakeAtMs`, claims, executes, acknowledges as two durable writes; Fastify removed from the engine process | Trigger/report/job flows pass end-to-end without an engine listener; `SF-08` order preserved |
| M7.8 `egress_outbox` and `F-02` closure | M7.5 | `feature-builder` + `security-reviewer` — `gpt-5.6-terra high` / `gpt-6-astra xhigh` | Durable report delivery; destination origin resolved against `config.agents[].url` **before** any `Authorization` header is constructed; no cross-origin redirects; CGNAT-pinned resolution | Callback to an unlisted origin is rejected with no credential constructed; peer-offline retries survive 10 min |
| M7.9 Static build matrix and packaging | M7.3 | `subsystem-builder` — `gpt-5.6-sol high` | `cargo zigbuild` CI for both musl Linux targets, gnu fallback, two Darwin targets; `lipo` universal macOS binary; checksums; version pinned to the npm version | `readelf -d` reports zero `NEEDED` on musl targets; binary <=2 MiB; no Rust toolchain required on host |
| M7.10 Supervisor migration | M7.7, M7.9 | `subsystem-builder` — `gpt-5.6-sol high` | `systemd` units with `Type=notify`, `Restart=always`, `MemoryMax=32M`, `IPAddressDeny`/`Allow`; `launchd` plist equivalents; `scripts/install.sh` extended, not duplicated | A killed worker restarts within `RestartSec`; RSS breach past `MemoryMax` kills the service and fails the suite |
| M7.11 Tailnet bind enforcement | M7.9 | `security-reviewer` + `test-engineer` — `gpt-6-astra xhigh` / `gpt-5.6-sol high` | Four-layer enforcement: address preflight exiting `78`, `nft` rules, `IPAddressDeny`/`Allow`, Tailscale ACL | Non-`tailscale0` ingress refused at all four layers; absent bind address exits `78` without binding |
| M7.12 Bound enforcement (`SF-15`) | M7.5 | `feature-builder` — `gpt-5.6-terra high` | Global inflight cap, per-`source_agent_id` cap, row cap, oldest-row age cap; `429` + `Retry-After` on breach | Flood test yields `429` with no unbounded buffer or queue growth |
| M7.13 TUI decoupling assertion | M7.7 | `test-engineer` — `gpt-5.6-sol high` | Source-scan test forbidding import edges from `src/tui/**` to the ingress queue or `src/jobs/`; `/v1/mesh/*` routing test | Test fails if the coupling is introduced; router answers `404`, never `101` or streaming `200`, for both mesh paths |
| M7.14 Canary rollout | M7.4, M7.7, M7.8, M7.10, M7.11 | `milestone-lead` + `independent-reviewer` — `gpt-6-astra high` | `test-vps` cutover, 7-day soak, then `dev-main` cutover, 7-day soak | Rollback in <5 s with no rebuild; zero loss across both soaks |
| M7.15 Security review of the trust boundary | M7.3–M7.13 | `security-reviewer` — `gpt-6-astra xhigh` | Adversarial review of the router as a new trust boundary; verify `F-05` was not relocated | No authority creep: engine still runs `assertSourceAuthorized`; router implements no plan approval |
| M7.16 Milestone gate audit | All | `independent-reviewer` — `gpt-6-astra high` | Resource deltas against baseline **under §5.1.1 A1–A4** (>=3 captures, spread <=10%, steady state under sustained load), rollback evidence, open findings, macOS parity gap recorded honestly | All completion criteria evidenced; reduction reported as three-process total, never the router alone; an inadmissible resource KPI is reported `not-gateable`, not passed |

## Two-Tier Validation Contract

This is the milestone's central design constraint. It is stated here so no task quietly collapses it.

| Tier | Component | Question | Authority |
| --- | --- | --- | --- |
| 1 | `aibr-router` | "Is this shaped like a valid request?" | **Rejection filter only** |
| 2 | `aibr worker` | "Is this caller allowed to do this?" | **Sole authority** |

Tier 2 retains the complete ordering in
[`src/server/routes/trigger.ts:13`](../../src/server/routes/trigger.ts):
`assertSourceAuthorized`, `assertProjectAllowed`, `ConfigPlanReviewProvider`,
opencode health, dependency resolution, duplicate rejection, kernel seam. The
worker **re-runs `triggerRequestSchema.safeParse` on the delivered payload.**

The router must **not** implement `plan_status: "approved"` as a trust signal.
`F-05` treats legacy approval and source fields as assertions; implementing them in
a component with no identity model would relocate a High finding rather than
close it. M7.15 exists to verify this did not happen.

## Route Migration Boundary

Four stateless routes move:

| Method | Path | Current owner |
| --- | --- | --- |
| `GET` | `/health` | [`src/server/routes/health.ts:5`](../../src/server/routes/health.ts) |
| `POST` | `/trigger` | [`src/server/routes/trigger.ts:13`](../../src/server/routes/trigger.ts) |
| `GET` | `/jobs/:id` | [`src/server/routes/jobs.ts:5`](../../src/server/routes/jobs.ts) |
| `POST` | `/report` | [`src/server/routes/report.ts:9`](../../src/server/routes/report.ts) |

Two **do not** move and stay on the Bun process:

| Method | Path | Why it cannot move |
| --- | --- | --- |
| `GET` | `/v1/mesh/terminal` | WebSocket, single input owner (`SF-10`), manual takeover. A queue cannot be interposed between a peer and a stateful connection. |
| `GET` | `/v1/mesh/events` | Long-lived SSE with snapshot re-base and cursor resume. The resume cursor is per-connection state with no durable analogue here. |

Neither is currently registered by `createApp()` — both are exercised only by test
harnesses ([`tests/integration/mesh-fixtures.ts:360`](../../tests/integration/mesh-fixtures.ts)),
so this costs nothing today. M7.13 asserts the router answers `404` for both.

## Durability Requirements

The router's schedule is a port of
[`src/mesh/outbox/policy.ts:68`](../../src/mesh/outbox/policy.ts):

| Property | Value | Source |
| --- | --- | --- |
| Backoff | `1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s`, 300 s ceiling | `DELIVERY_BACKOFF_MS` |
| Max attempts | 8 | `MESH_OUTBOX_MAX_ATTEMPTS` |
| Claim lease | 30 000 ms | `MESH_OUTBOX_CLAIM_LEASE_MS` |
| Total backoff before last attempt | 127 s | `totalBackoffMs()` |
| Terminal records | **retained with `terminal_error`**, never deleted | `terminalDeliveryError`, `policy.ts:147` |
| `attempts` reset | **never**, by any path including `recoverStale` | `deliverer.ts:39` |

**One documented deviation.** `policy.ts:30` justifies an un-jittered schedule
because the codebase has one controller per run by construction. Ingress now has
many routers fanning into one store during the M7.14 rolling upgrade, so
**full-jitter** applies: `sleep = rand(0, min(300s, 2^n * 1s))`. The deviation is
recorded at the deviation site in both languages, and M7.6 asserts parity only
over the deterministic ceiling and threshold, not the jitter draw.

The crash-window matrix:

| Scenario | Required outcome |
| --- | --- |
| Router dies before commit | `503`, zero rows, caller retry succeeds |
| Router dies after commit, before `202` | Row present; caller retry converges via `ON CONFLICT`, one job |
| Worker dies holding a claim | `recoverStale` requeues, `attempts` preserved |
| Worker restarts 8 times | Row terminal at attempt 8, **row still readable** |
| SQLite store deleted | Router exits `78`; **no in-memory fallback** |
| Poison payload | Terminal row retained with `terminal_error`; visible to diagnostics |
| Peer offline 10 min | Egress backoff spans ~2^10 attempts, not 600 000 |

## Security Findings Closed

| ID | Finding | Severity | Closed by |
| --- | --- | --- | --- |
| `F-01` | `job_id` -> `join(directory, job.id + ".json")`; `../escaped` escapes the store | High | Router rejects non-`[A-Za-z0-9_-]` ids at ingress; M7.3 |
| `F-02` | Callback forwards bearer token to a caller-supplied `callback_url` | High | `egress_outbox` origin binding before header construction; M7.8 |
| `F-03` | `GET /jobs/:id` has **no authentication at all** | High | Read route moves into the router behind bearer auth; M7.3 |
| `F-04` | Lexical `resolve()` equality, no `realpath` | High | Router canonicalises and enforces containment; M7.3 |
| `F-06` | Unversioned legacy state, `JSON.parse` cast | High | `schemaVersion` envelope, unknown version refused; M7.3 |

Reproductions in
[`Docs/security/milestone-0-threat-model.md:100`](../security/milestone-0-threat-model.md)
are the acceptance corpus. M7.15 verifies the reproductions and confirms `F-05` was
not relocated.

## Contract Requirements

`src/config/schemas.ts` remains the source of truth per
[`README.md:66`](./README.md). `ts-rs` is **not** used: it derives Rust from
TypeScript types, which would create a fourth hand-maintained copy alongside the
Zod schema, the `z.infer` re-export, and the generated struct.

```
Zod schemas (SOURCE OF TRUTH)
  src/config/schemas.ts          — ingress closure: trigger, report, config
  src/orchestration/schemas.ts   — the 15 orchestration record schemas
      |  z.toJSONSchema()   (Zod 4 native; NOT zod-to-json-schema, see below)
      v
contracts/v1/*.schema.json   (COMMITTED, reviewable in a PR diff)
      |  typify
      v
router/src/contracts.rs     (GENERATED — "DO NOT EDIT" header)
```

**Two amendments M7.2 measured into this chain:**

1. `zod-to-json-schema@3.25.2` (latest) does not support Zod 4 — it returns `{}` for
   `z.strictObject({a: z.string()})`, silently discarding every property. Zod 4.4.3
   ships `z.toJSONSchema()` natively, emits draft 2020-12, and is exact. Using it
   adds **zero** devDependencies instead of one broken one.
2. The 15 fixtures bind to `src/orchestration/schemas.ts` (85 schemas), **not** to
   `src/config/schemas.ts` — the ingress closure covers zero of them. The set is
   therefore the **union** of both closures, or §9's 15/15 is untestable.

**Unknown-key rejection is a post-pass**, injecting `additionalProperties: false`
into closed object schemas, never a hand-written field shape. This makes the
router strictly stricter than the engine (which strips unknown keys). That
asymmetry is intended by §2.2 Tier 1 and is recorded so it is not later "fixed"
into symmetry.

CI runs `git diff --exit-code contracts/` after generation. Serialization is JSON
only, per ADR 0008 §2.4 and the precedent of ADR 0007 §5.

## Supervisor Requirements

The current supervisor cannot satisfy the durability claim:
[`src/host/tmux.ts:34`](../../src/host/tmux.ts) runs only `tmux has-session`, and
[`tmux.ts:87`](../../src/host/tmux.ts) returns `already_running` on that result, so
a session whose window has died still reports healthy. There is no restart policy,
no PID file, and no log rotation.

| Platform | Mechanism |
| --- | --- |
| Linux | `systemd` — `Type=notify`, `Restart=always`, `RestartSec=2`, `MemoryMax=32M`, `IPAddressDeny=any`, `IPAddressAllow=100.64.0.0/10`, `ExecStartPre` preflight |
| macOS | `launchd` — `KeepAlive`, `RunAtLoad`, `ThrottleInterval=10`, `MemoryLimit` |

`MemoryMax=32M` against a 1.94 MiB measurement makes the resource claim an
enforced invariant. `scripts/install.sh` is extended to fetch the router binary; a
second installer is not created. Guardrail
[`README.md:78`](./README.md) keeps release, publish, deployment, and credential
rotation outside sub-agent authority.

## Tailnet Bind Requirements

Four independent layers, because each has a plausible single failure:

| Layer | Mechanism | Fails if |
| --- | --- | --- |
| Application | Bind the configured CGNAT address, never a wildcard; preflight exits `78` (`EX_CONFIG`) if absent from `tailscale0` | config drift |
| Kernel | `nft`: accept `iifname "tailscale0" tcp dport 8787`, drop all other `dport 8787` | `nft` not loaded |
| cgroup | `IPAddressDeny=any` + `IPAddressAllow=100.64.0.0/10` (systemd >= 235) | systemd < 235 |
| Overlay | Tailscale ACL restricting `:8787` to the two node tags | ACL misconfiguration |

`SO_BINDTODEVICE` is rejected in favour of explicit-address bind plus `nftables`
because it requires `CAP_NET_RAW`, a broader grant than needed.

## Benchmarking Requirements

### 5.1 Measurement discipline

Three traps. The first two were encountered while drafting ADR 0008; the third was
measured by M7.0, after the ADR was written, and it invalidates the first two as a
*sufficient* rule.

1. **RSS deltas over a short window on Bun are not evidence.** RSS *fell* 4.4 MiB
   across 500 requests because JSC returned pages to its allocator. Never report a
   delta.
2. **JIT allocation is lazy**, so a 2 s sample after start under-reports. Sample
   at >=1 Hz for >= 60 s.
3. **A single idle capture is not a measurement of this quantity.** M7.0 captured
   the *unchanged* engine three times, each individually compliant with rule 2, and
   got sum medians of **55.95 / 34.84 / 34.63 MiB** — a **61% run-to-run spread**
   on a process that never changed. The process sits on RSS plateaus of roughly
   24, 35, and 54 MiB and migrates between them on a minute timescale while idle. A
   warmup sweep did not pin it: 45 s settles *lower* (23.8 MiB) than 75 s (35.0 MiB),
   so the plateau is not a function of elapsed time either.

   **This means the effect being measured is smaller than the measurement noise.**
   The target is ~21% (57.3 -> 45 MiB); the noise is ~61%. Rules 1 and 2 are
   necessary but not sufficient, and ADR 0008 §1's single 57.3 MiB figure is one
   draw from this distribution, not the quantity the gate compares against.

Report median and p95 for **all three processes** (`aibr-router`, `aibr worker`,
`aibr tui`) and their sum. Reporting the router's 1.94 MiB while omitting the
43 MiB worker it was added to would be a dishonest headline.

#### 5.1.1 Gate admissibility

A resource comparison is **admissible** only when all four hold. `bench/mem.sh`
reports run-to-run variance and refuses to pass an inadmissible comparison; these
rules are what its `insufficient-samples` and `noise` verdicts mean operationally.

| # | Rule | Why |
| --- | --- | --- |
| **A1** | >=1 Hz for >=60 s, every capture | Rules 1–2 |
| **A2** | >=3 independent captures per quantity; the **median of the per-capture medians** is the reported figure | Rule 3: one capture is one draw |
| **A3** | Run-to-run spread of the per-capture medians must be **<= 10%**, else the quantity is **not gateable** and is reported as `not-gateable` | At 61% the harness cannot distinguish the change from a plateau migration |
| **A4** | Baselines are captured on the **same host, same boot, same `ingress_mode`, same capture protocol** as candidates | Cross-host comparison reintroduces rule 3 at a larger scale |

**The quantity being gated is steady state under sustained load, not idle.** Rule 3
removes "idle" as a well-defined quantity for a Bun process: its value depends on
which allocator plateau JSC happens to be holding. Under sustained traffic at a
fixed low rate (the load profile is fixed in `bench/baseline/capture-config.json`
and must not change mid-milestone) JSC cannot release pages, the plateau is pinned,
and the level becomes the thing that actually varies with the *code*. M7.0's
artefact records this as `steadyState`.

**If A3 fails on the reference host, M7.16 reports the resource KPI as
`not-gateable` with the variance figures attached.** That is an acceptable and
honest milestone outcome. Reporting a single 60 s capture as a pass is not.

### 5.2 Comparison matrix

| KPI | Measured baseline (M7.1) | Target |
| --- | --- | --- |
| Total RSS, steady state, three processes | 69.13 MiB, spread 34.7%, **not gateable** | **re-baseline required — see R-M7.1-1** |
| — `aibr-router` | 1.91 MiB (lower bound; stub has no SQLite) | <= 4 MiB |
| — `aibr worker` (no Fastify) | 46.98 MiB, spread 6.35% | <= 48 MiB (**margin 1.02 < spread 2.98 — unresolvable by re-capture**) |
| CPU idle | 0.0% | <= 0.5% |
| CPU spike, 500-request burst | — | < 15 ms |
| Admission latency p50 / p99 | not baselined (no `opencode serve` on this host) | <= 2 ms / <= 10 ms |
| Webhook -> engine accept, p50 | not baselined | <= 15 ms |
| Zero loss across 24 h soak | — | 0 |
| Rollback time | — | < 5 s, no rebuild |
| Open High findings closed | 5 open | 5 closed |

**The `<= 45 MiB` total target this milestone originally specified is withdrawn.**
The worker alone measures ~47 MiB before the router, the TUI, or `opencode serve`,
so no total below ~50 MiB is reachable with this topology. M7.16 must re-baseline
this row rather than report a pass against a target known to be out of reach.

### 5.3 Rollout

`bridge.ingress_mode` defaults to `"engine"`. Each step is independently
revertible; deletion of the Fastify listener is a **separate reviewed change** after
the flag default flips, because collapsing them destroys rollback.

1. Default `"engine"`. Shadow mode 72 h, zero divergence.
2. Canary `test-vps` — lower blast radius, no production project paths.
3. Soak 7 days.
4. Canary `dev-main`.
5. Default `"router"` for new installs.
6. Then, separately, remove Fastify from `src/server/`.

## Completion Criteria

### Contracts

- [ ] ADR 0008 accepted and signed by the `security-reviewer` before any Rust source exists.
- [ ] - [ ] `contracts/v1/` committed and reviewed; all **15** `tests/contracts/examples/*.v1.json` parse identically in both languages — across **both** closures, since the fixtures bind to `src/orchestration/schemas.ts`, not the ingress schemas.
- [ ] `git diff --exit-code contracts/` clean after generation; zero hand edits to generated Rust.
- [ ] Unknown or missing `schemaVersion` produces an explicit refusal, never coercion.
- [ ] Engine Zod re-parse at admission is <= 1 ms p99, proving the double parse is affordable.

### Resource

- [ ] Router RSS <= 4 MiB as median and p95 over >= 60 s, against `MemoryMax=32M`. **M7.1 measured 1.91 MiB as a lower bound; the `sqlx` + SQLite cost is unmeasured (R-M7.1-4).**
- [ ] Worker-without-Fastify <= 48 MiB. **M7.1 measured 46.98 MiB, margin 1.02 MiB against a 2.98 MiB spread — report the point estimate and spread, not a clean pass (R-M7.1-2).**
- [ ] **The total-RSS KPI is re-baselined.** The `<= 45 MiB` target is withdrawn as unreachable; M7.16 must establish a new target against a baseline whose run-to-run spread is <=10%. Three captures of the unchanged engine spread 34.7% (R-M7.1-1).
- [ ] Idle and steady-state figures are labelled distinctly everywhere they appear. The 57.3 MiB idle figure and the 69.13 MiB steady-state figure are different quantities and neither may be cited as the other (R-M7.1-3).
- [ ] All resource comparisons gated under §5.1.1 rules A1–A4, with the per-capture series committed. An inadmissible KPI is reported `not-gateable`, **not** passed on a single capture.
- [ ] Binary <= 2 MiB per target; `readelf -d` reports zero `NEEDED` on musl targets.
- [ ] No Rust toolchain required on any host.
- [ ] Every resource figure in the report is a level with median/p95, never a delta.

### Durability

- [ ] Zero loss across 1000 kill/restart cycles.
- [ ] Zero duplicate executions under `job_id` PK plus `ON CONFLICT DO NOTHING`.
- [ ] Poison message terminal by attempt 8 within 127 s and **remains readable**.
- [ ] `attempts` preserved across `recoverStale`; no path resets it.
- [ ] Router death pre-commit yields `503` and zero rows.
- [ ] SQLite store deletion exits `78` with no in-memory fallback.
- [ ] Backoff parity: 16/16 golden vectors; jitter deviation documented at both sites.
- [ ] Egress to an unlisted origin rejected **before** an `Authorization` header exists.

### Security

- [ ] `F-01` through `F-04` and `F-06` closed at ingress, reproductions as the corpus.
- [ ] `F-05` verified **not** relocated; engine still runs `assertSourceAuthorized`; router implements no plan approval.
- [ ] All four tailnet-bind layers refuse non-`tailscale0` ingress.
- [ ] Router exits `78` without binding when the configured address is absent from the interface.
- [ ] Canary bearer token appears in no log, diagnostic, or error body.
- [ ] No upward import edge from `router/` into `src/`; `src/` has no dependency on `router/`.
- [ ] Router answers `404` for both `/v1/mesh/*` paths, never `101` or streaming `200`.
- [ ] No import edge from `src/tui/**` to the ingress queue or `src/jobs/`.
- [ ] Flood test yields `429` with no unbounded queue or buffer (`SF-15`).

### Operations

- [ ] A killed worker restarts within `RestartSec`.
- [ ] RSS breach past `MemoryMax` kills the service and fails the suite.
- [ ] `test-vps` cutover with a 7-day soak, then `dev-main` cutover with a 7-day soak.
- [ ] Rollback in < 5 s with no rebuild, in both directions.
- [ ] `test-vps` shadow divergence zero over 72 h.

### Honest reporting

- [ ] The reduction is reported as a **three-process total**, never the router alone.
- [ ] **No report claims −39%.** The measured figure is **−29.3%**, stated with its spread, against a baseline that is itself not gateable (R-M7.1-1).
- [ ] The gate report states that `opencode serve`, the ~20 MiB Bun runtime floor, and `@opentui/core` (19 MB, separate process) are **untouched**, so this is not a host-level footprint result.
- [ ] The withdrawn `<= 45 MiB` target is reported as withdrawn, with the reason.
- [ ] The macOS `launchd` parity gap is recorded, not footnoted.

## Guardrails and Stop Conditions

- **Do not** widen `README.md:77` beyond `router/`. The guardrail stands unchanged for `src/`.
- **Do not** let the router's structural check become an authorization decision. A 50 µs check that permits a dispatch is a new High finding.
- **Do not** implement `plan_status` approval in the router. `F-05` is relocated, not closed.
- **Do not** delete the Fastify listener in the same change as the migration. Rollback is one config key.
- **Do not** add an in-memory fallback when SQLite is unavailable. It would silently drop admitted work; exit `78` instead.
- **Do not** introduce a message broker. ADR 0008 §5 records why, and names what would have to change before one could be reconsidered.
- **Do not** couple the TUI to the worker or the ingress queue. `SF-11` requires detach to preserve node-owned sessions.
- **Do not** migrate `/v1/mesh/*` in this milestone. Statefulness has no durable analogue here.
- **Do not** hand-edit generated contract files.
- **Do not** follow cross-origin redirects with a credential attached.
- **Do not** bind a wildcard address, and do not use `SO_BINDTODEVICE` in place of the `nft` layer.
- **Do not** promise a single static macOS binary. Apple targets do not support `crt-static`.
- **Do not** raise `MemoryMax` to make a regression pass. Fix the regression.
- Stop the milestone for any unresolved blocker/high security issue, any webhook loss under soak, any duplicate execution, or any silent coercion of an unknown version.

## Gate Verification

```bash
# Rust router
cd router && cargo fmt --check && cargo clippy -- -D warnings && cargo test

# Contracts are reproducible and committed
bun run generate:contracts
git diff --exit-code contracts/

# Cross-cutting
bun run typecheck
bun test
bun run build
git diff --check

# Packaging
bun run release:check

# Resource and latency, per §5.1
bun bench/mem.sh --all --samples 60
```

The final report is `Docs/implementation-reports/milestone-7-completion.md` and
includes: three-process resource levels with median/p95 under §5.1.1, the
shadow-mode divergence result, both soak results, rollback timing in both
directions, the closed-findings corpus, the macOS parity gap, and the `readelf -d`
output for each musl target. The root agent, independent reviewer, and security
reviewer all sign off per
[`README.md:113`](./README.md). A release is not implied by plan completion.

## Prerequisites Handed to Milestone 8

- **M8.5** ("Resource/load limits") is the named revisit condition for ADR 0008 §2.4's JSON-only decision. It must measure whether any payload class's serialized size dominates ingress cost at documented supported load, and either confirm JSON or open a versioned binary-format contract.
- **M8.9** ("Packaging/platform matrix") must cover the router's five build targets in addition to the npm package.
- **M8.2** ("Database integrity, backup, and repair tooling") must cover `ingress_outbox` and `egress_outbox`, including outbox repair and the retained-terminal-row evidence path.
- **M8.3** ("Structured observability") must add router signal family: admission rate, rejection reason, outbox depth/age, terminal-row count, and bind-layer health — with the canary-token audit applied.
- **M8.4** ("Diagnostics bundle") must include router version, bind preflight result, and outbox integrity status without payload contents.
- **M8.7** (Adapter/terminal SDK) must not expose the router's internal types; the ingress contract is JSON over a socket plus `contracts/v1/`.
- **M8.8** (Herdr experiment) is unaffected; Herdr remains a `TerminalBackend` and does not touch ingress.
- The `/v1/mesh/*` migration remains **unassigned**. It needs a design for stateful ownership over a durable transport and must not be scheduled alongside stateless ingress work.
- The `macOS launchd` parity gap is carried forward as an open item if M7.16 could not test it to the same standard as Linux.
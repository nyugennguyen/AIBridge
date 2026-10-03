# ADR 0008: Polyglot ingress router and durable admission

Status: accepted for Milestone 7 (M7.1).

Depends on [ADR 0001](0001-canonical-domain-and-module-boundaries.md),
[ADR 0002](0002-versioned-contracts-and-adapter-boundaries.md),
[ADR 0003](0003-event-store-and-idempotency.md),
[ADR 0004](0004-controller-leases-and-recovery.md),
[ADR 0007](0007-rule-language-and-evaluation.md), and the versioned schemas in
[`src/config/schemas.ts`](../../src/config/schemas.ts).

Purpose: authorise the guardrail in
[`Docs/implementation-plans/README.md:77`](../../Docs/implementation-plans/README.md)
("Do not add a second programming language unless a milestone plan explicitly
changes this decision through an ADR") for a single, narrow Rust component, and
record why a message broker was evaluated and rejected. This ADR changes the
language guardrail for `router/` ONLY. The rule stands unchanged for `src/`.

## 1. The measurement that motivates this

The premise for the milestone was that a Bun HTTP listener is a resource problem.
Measured on the reference host (macOS 26.6.2 / arm64, Bun 1.3.14, Rust 1.94.1),
the live `aibr serve` process resolves as follows. Each row is a separate
in-process probe importing one module at a time:

| Step | RSS | Delta |
| --- | --- | --- |
| Bun process floor | 22.9 MiB | — |
| `import fastify` | 45.6 MiB | +22.7 MiB |
| `import zod` | 57.1 MiB | +11.5 MiB |
| `import @opencode-ai/sdk/v2` | 59.6 MiB | +2.5 MiB |
| Zod parse of a full `config.json` | 65.0 MiB | +5.4 MiB |
| `src/server/app.ts` routes | 65.7 MiB | +0.7 MiB |
| `JsonFileJobStore` first write | 66.0 MiB | +0.3 MiB |
| `app.listen()` | 74.5 MiB | +8.5 MiB |

End-to-end, the running bridge measures **57.3 MiB idle RSS across 14 threads at
0.0% CPU**.

Two corrections follow, and both matter more than the premise they replace.

**There is no `Bun.serve()` in this codebase.** A source scan finds none in
`src/`. The HTTP layer is Fastify, constructed once at
[`src/server/app.ts:38`](../../src/server/app.ts) with exactly two `.listen()`
call sites: [`src/index.ts:16`](../../src/index.ts) (dev) and
[`src/cli.ts:404`](../../src/cli.ts) (`aibr serve`). Fastify's total contribution is
**31.2 MiB — 42% of the process.** The listening socket is a small part of that;
the module graph is the cost. The correct target is therefore Fastify's module
graph, not a socket.

**RSS deltas measured over a short window on Bun are not evidence.** During
baselining, RSS *fell* 4.4 MiB across 500 requests because JSC returned pages to
its allocator. Every figure above is a level, not a difference between two short
samples, and future reporting must sample at >=1 Hz for >= 60 s and report median
and p95. See
[`milestone-7-polyglot-ingress.md` §5.1](../implementation-plans/milestone-7-polyglot-ingress.md).

**Amended by M7.0: the rule above is necessary but not sufficient, and the 57.3 MiB
figure is one draw from a wide distribution.** Building the measurement harness
(`bench/`) and capturing the *unchanged* engine three times produced sum medians of
**55.95 / 34.84 / 34.63 MiB** from three individually compliant captures — a **61%
run-to-run spread** on a process that never changed. Bun's RSS sits on plateaus
(~24, ~35, ~54 MiB) and migrates between them on a minute timescale while idle; a
warmup sweep did not pin it, since 45 s settles *lower* than 75 s.

Two consequences, both of which weaken this ADR rather than strengthen it:

1. The reduction this milestone targets (~21%) is **smaller than the measurement
   noise of a single idle capture**. The −39% figure is a projection from a
   component breakdown, not a demonstrated quantity.
2. The gated quantity is therefore **steady state under sustained load**, not idle,
   and a comparison requires >=3 captures with run-to-run spread <=10%
   ([`milestone-7-polyglot-ingress.md` §5.1.1](../implementation-plans/milestone-7-polyglot-ingress.md)).

**Measured by M7.1, superseding the projection:** the worker-without-Fastify
measures **46.98 MiB** (median of 6 capture medians, spread 6.35%) — **3.68 MiB
above the 43.3 MiB projection this section originally derived.** The projection
was optimistic because subtracting Fastify's 31.2 MiB understates what the engine
keeps: Zod, the OpenCode SDK, and JSC's own footprint survive the removal.

The `<= 48 MiB` criterion passes on the median by 1.02 MiB, but the run-to-run
spread is 2.98 MiB, so **the pass is not resolvable by re-capturing**; see
[`milestone-7-router-spike.md`](../spikes/milestone-7-router-spike.md). The
router stub's 1.94 MiB projection **did** hold (1.906 MiB measured, 558 KiB
binary), but that is a lower bound — the real router adds SQLite via `sqlx`.

Two consequences follow, both weakening this ADR:

1. **The measured reduction is −29.3%, not −39%** — worker+router 48.86 MiB
   against a 69.13 MiB baseline. The baseline is higher than the 57.3 MiB above
   because the spike measures **steady state under sustained load** while §1
   measured **idle**; those are different quantities and §5.1.1 changed the gated
   one deliberately.
2. **The baseline is not gateable.** Three captures of the *unchanged* engine
   spread 34.7% (62.1–86.1 MiB). A comparison whose baseline cannot be reproduced
   cannot yield a trustworthy percentage, so **−29.3% is a point estimate with a
   stated spread, not a result.**

If the run-to-run spread cannot be brought under 10% on the reference host, the
resource KPI is reported `not-gateable`. That is an honest milestone outcome.
Reporting one 60 s capture as a pass is not.

## 2. Decision

A new Rust binary, `aibr-router`, owns ingress. It is the only component permitted
to open a listening socket in this system outside `opencode serve`'s loopback
interface and the two stateful mesh routes excluded in §6.

`aibr-router` is a **stateless structural gate**. It parses, authenticates,
bounds, versions, and durably records. It performs **no authorization decision**.
Admission to a durable SQLite queue is its only write. It never launches a
runtime, never reads project contents, never evaluates policy, and never holds
agent state.

The existing Bun engine loses its HTTP listener and its Fastify dependency and
becomes a worker that drains the queue. It remains the semantic authority for
every decision the router refuses to make.

**No message broker is introduced.** Durable admission is the existing SQLite
outbox, re-deployed for ingress. See §5 for the reasoning and for what would have
to change before a broker could be reconsidered.

### 2.1 Component layout

```
 tailscale0 (100.64.0.0/10) — address bind + nftables + IPAddressAllow, nothing else
                |
 +--------------v---------------+
 |      aibr-router (Rust)       | axum 0.8 + tokio, 1.94 MiB, 590 KiB binary
 |      structural gate only     | serde + sqlx
 +---+----------------------+----+
 202 |                      | 4xx / 429 / 503 — no durable write
     v                      v
 +--------------------------------+
 | SQLite ingress_outbox (WAL)    | policy ported from src/mesh/outbox/policy.ts
 | egress_outbox                  | F-02 closed at enqueue, not at send
 +----------------+---------------+
                  | poll(nextWakeAtMs)
 +----------------v---------------+
 |  aibr worker (Bun)  ~43 MiB    | NO Fastify, NO listener
 |  kernel / opencode / jobs      |
 |  SQLite event store (WAL)      |
 +----------------+---------------+
                  | projections
 +----------------v---------------+
 |  aibr tui (Bun + opentui)      | SEPARATE PROCESS — never coupled (§7)
 +--------------------------------+
```

Projected result, from §1:

| Topology | RSS (measured M7.1) | Note |
| --- | --- | --- |
| Today, engine with Fastify | 69.13 MiB | spread 34.7% — **not gateable** |
| Worker + router stub | 48.86 MiB | spread 2.85% — gateable |
| — of which worker | 46.98 MiB | projection was 43.3 |
| — of which router stub | 1.91 MiB | projection 1.94 confirmed |

Measured reduction **−29.3%**, not the −39% this ADR originally claimed. The
`<= 45 MiB` total target is **known to be unreachable** on this host with this
topology: the worker alone is ~47 MiB before the router, the TUI, or
`opencode serve`. The target assumed the projection was exact, and it was not.

The router figure is a **lower bound**. The stub has no SQLite or `sqlx`; M7.5's
`ingress_outbox` adds memory this spike cannot show.

### 2.2 Two-tier validation, stated so it cannot be quietly collapsed

| Tier | Component | Question | Cost | Authority |
| --- | --- | --- | --- | --- |
| 1 | `aibr-router` | "Is this shaped like a valid request?" | ~50 µs | Rejection filter only |
| 2 | `aibr worker` | "Is this caller allowed to do this?" | ~1 ms p99 | **Sole authority** |

Tier 1 covers presence, type, enum membership, size bounds, unknown-key
rejection, format (`z.url()`, UUID, RFC 3339), `job_id` charset, and
`project_dir` realpath containment.

Tier 2 retains the complete existing ordering in
[`src/server/routes/trigger.ts:13`](../../src/server/routes/trigger.ts):
`assertSourceAuthorized`
([`src/security/source-authorization.ts:4`](../../src/security/source-authorization.ts)),
`assertProjectAllowed`, `ConfigPlanReviewProvider`, opencode health, dependency
resolution, duplicate rejection, and the orchestration kernel seam. The worker
**re-runs `triggerRequestSchema.safeParse` on the delivered payload.**

This asymmetry is deliberate and is not an oversight to be optimised away. ADR
0007 §17 and `SF-16` require that a cheap check never acquire authority it has
not earned. A 50 µs Rust check that permitted a dispatch would be a new High
finding manufactured by this milestone.

**`plan_status: "approved"` is not a trust signal to the router.** `F-05`
disposes of legacy approval and source fields as *assertions*. The router has no
identity model and must not implement plan approval, or it relocates that finding
into a component with fewer defences than the one it replaces.

### 2.3 Contracts

Zod schemas remain the single source of truth, per
[`README.md:66`](../../Docs/implementation-plans/README.md). Generation runs
**Zod 4's built-in `z.toJSONSchema()`** -> committed JSON Schema -> `typify` -> Rust.

**Amended by M7.2: `zod-to-json-schema` is not used.** This section originally
named it. Measured: `zod-to-json-schema@3.25.2` (the latest) does not support Zod
4 — `zToJsonSchema(z.strictObject({ a: z.string() }))` returns `{}`, silently
discarding every property. Zod 4.4.3 ships the converter natively as
`z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" })`, emits draft
2020-12, and is **exact**: `z.object` yields no `additionalProperties` (permits)
while `z.strictObject` yields `additionalProperties: false` (rejects).

Using the native converter also means **zero new devDependencies**. The named
package would have added a broken one.

**Amended by M7.2: the contract set is two closures, not one.** This section said
`src/config/schemas.ts`. Measured: the 15 fixtures in `tests/contracts/examples/`
bind to the **85 schemas in `src/orchestration/schemas.ts`**, and
`src/config/schemas.ts` is referenced by neither the fixtures nor that file — the
ingress closure (`triggerRequestSchema`, `reportCallbackSchema`,
`bridgeConfigSchema`) covers **zero** of the 15. So §9's "all 15 fixtures parse
identically in both languages" is untestable against the ingress closure alone.

The committed set is therefore the **union**: the ingress closure the router's
four routes consume, plus the 15 orchestration record schemas. Both are curated by
hand and both derive their structure from Zod; neither is a blanket re-export.

**Unknown-key rejection is a post-pass, not a hand-written shape.** The generator
must not re-declare field shapes — that is the fourth hand-maintained copy this
section exists to prevent. A post-pass injects `additionalProperties: false` into
closed object schemas; structure stays fully derived from Zod.

**This makes the router strictly stricter than the engine, deliberately.** The
engine's Zod `z.object` schemas *strip* unknown keys; the router *rejects* them.
That asymmetry is what §2.2 wants of Tier 1, but it is a real semantic
difference between two components over the same schema and is recorded here so it
is not later "fixed" into symmetry.

`ts-rs` is **not** used. It derives Rust from TypeScript *types*, but the source
of truth here is Zod *schemas*, so its output would be a fourth hand-maintained
copy alongside the schema, the `z.infer` re-export in
[`src/config/types.ts`](../../src/config/types.ts), and the generated struct. The
chain above produces one generated artefact per boundary type and no hand-edited
Rust contract.

Committed artefacts under `contracts/v1/` are reviewable in a pull-request diff.
CI runs `git diff --exit-code contracts/` after generation; a hand edit to a
generated file is a build failure, not a review comment. A generated file that is
never reviewed is worse than no file, so the export is committed rather than
built into `target/`.

Unknown or missing `schemaVersion` is an explicit refusal, never a silent
downgrade or coercion (`SF-14`, ADR 0002).

### 2.4 Serialization is JSON, following ADR 0007 §5

No MessagePack, no Protocol Buffers, no CBOR.

ADR 0007 §5 already established "serialization is JSON only in the initial
release" as a **deferral with a named revisit condition** rather than an
oversight. The same convention applies here. The named condition:

> Revisit if and only if M8.5 load testing (formerly M7.5, "Resource/load
> limits") identifies a payload class whose serialized size is measured to
> dominate ingress cost at documented supported load.

The size argument is void at this topology. The configured job timeout is 1800 s
([`config/dev-main.example.json`](../../config/dev-main.example.json)), so even a
1 MiB webhook amortises to ~0.55 B/s; body size is already bounded at 1 048 576
bytes by [`src/server/app.ts:38`](../../src/server/app.ts). Beyond size, JSON is
the only format inspectable during an incident with `sqlite3` and `jq`, which
serves the stated objective of diagnosability better than the ~40% size reduction
buys. Each additional format adds a codegen artefact that must be reconciled
against Zod — the exact drift surface §2.3 exists to contain.

### 2.5 Durability reuses the proven outbox policy

The router's schedule is a direct port of
[`src/mesh/outbox/policy.ts:68`](../../src/mesh/outbox/policy.ts):
`1s->2s->4s->8s->16s->32s->64s->128s` with a 300 s ceiling,
`MESH_OUTBOX_MAX_ATTEMPTS = 8`, `MESH_OUTBOX_CLAIM_LEASE_MS = 30_000`, `attempts`
never reset by any path, and terminal records **retained as evidence** rather than
deleted (`terminalDeliveryError`,
[`policy.ts:147`](../../src/mesh/outbox/policy.ts)).

A golden-vector test asserts both implementations return identical delays for
`attempts` in `[0,16)`. One schedule, two languages, one test.

**One documented deviation.** [`policy.ts:30`](../../src/mesh/outbox/policy.ts)
justifies an un-jittered schedule because "this codebase has exactly one
controller per run by construction (ADR 0004: no election, no gossip)." Ingress
now has many routers fanning into one store during the Phase 5 rolling upgrade,
so **full-jitter** backoff becomes correct: `sleep = rand(0, min(300s, 2^n * 1s))`.
The deviation is intentional, narrow, and recorded rather than silent.

Admission is durable before acknowledgement, per `SF-08`: a `202` is emitted only
after `synchronous=FULL` commit. A `202` that was not durable is a lie the worker
cannot distinguish from an acceptance. Persistence failure returns `503` and the
caller retries.

Claim and acknowledge remain **two separate durable writes**, per the ordering
argument at
[`deliverer.ts:54`](../../src/mesh/outbox/deliverer.ts). Collapsing them makes the
crash-between case unrepresentable.

### 2.6 Credential binding is decided at enqueue

`F-02` (High, open) is that `CallbackReporter.send` attaches the node bearer token
to a caller-supplied `callback_url`, validated only for URL syntax. The engine's
`reportCallbackSchema` accepts any `z.url()`.

`egress_outbox` rows are created only after the destination origin resolves against
`config.agents[].url`. An unlisted origin is rejected **before** an
`Authorization` header is ever constructed. Redirects are not followed across
origins, and resolution is pinned to `100.64.0.0/10`. This is `SF-17` expressed as
a construction rule.

### 2.7 Supervisor

Phase 3's durability claim depends on the worker restarting. The current
supervisor does not restart: [`src/host/tmux.ts:34`](../../src/host/tmux.ts) has no
restart policy, no PID file, and no log rotation, and a session whose window has
died still reports `already_running` because the liveness probe at
[`tmux.ts:34`](../../src/host/tmux.ts) runs only `tmux has-session` and
[`tmux.ts:87`](../../src/host/tmux.ts) returns on that result alone.

M7 therefore replaces `tmux` supervision with `systemd` (`Type=notify`,
`Restart=always`, `RestartSec=2`, `MemoryMax=32M`, `IPAddressDeny=any`,
`IPAddressAllow=100.64.0.0/10`) on Linux and an equivalent `launchd` plist
(`KeepAlive`, `ThrottleInterval`, `MemoryLimit`) on macOS. This is a prerequisite
of the durability claim, not an optional improvement, and it is where the
milestone's largest operational regression risk lives.

`MemoryMax=32M` converts the 1.94 MiB measurement into an enforced invariant: a
regression past the cap kills the service and fails the test suite.

### 2.8 Rollout is flag-gated before any deletion

`bridge.ingress_mode: "engine" | "router"` is added to `bridgeConfigSchema` with
`.default("engine")`, so every existing config keeps working and rollback is
deleting one key. Sequence, each step independently revertible:

1. Default `"engine"`. Shadow mode: router mirrors ingress, engine still listens.
   Compare for 72 h.
2. Canary `test-vps` (lower blast radius, no production project paths).
3. Soak 7 days.
4. Canary `dev-main`.
5. Default `"router"` for new installs.
6. **Then, in a separate reviewed change**, remove Fastify from `src/server/`.

Deleting the listener in the same change as the migration destroys rollback, and
[`src/server/app.ts`](../../src/server/app.ts) remains the seam that keeps it a
one-line revert.

## 3. Consequences

**Accepted costs.**

- A second build system (Cargo alongside `tsc`) and a five-target CI matrix.
- musl static linking does not cross-compile from macOS with a plain toolchain:
  `cargo build --release --target aarch64-unknown-linux-musl` fails with
  `linker 'cc' failed`. M7 uses `cargo-zigbuild` in CI. `cross` is unavailable
  because Docker is not present on the reference host.
- **Apple targets do not support `crt-static`.** There is no single static macOS
  artefact. M7 ships separate `x86_64-apple-darwin` and `aarch64-apple-darwin`
  builds combined with `lipo`. No documentation may promise otherwise.
- Contract generation adds a build hop and a three-artefact chain.
- `tmux` -> `systemd`/`launchd` is a real migration with macOS parity gaps.
- `ingress_outbox` and the SQLite event store are two durable records joined by
  `job_id`. A reconciliation test must assert 1:1; this is the milestone's
  principal correctness risk and is named as such in §2.8 and the plan's risk
  table.

**Gains.** Fastify's 31.2 MiB is removed from the engine: a **measured −29.3%**
total (48.86 MiB against a 69.13 MiB baseline), not the −39% first projected — see
§1 and the spike. Five open High findings are closable at ingress — `F-01`
(`job_id` -> path traversal via
`join(directory, job.id + ".json")`,
[`src/jobs/store.ts:36`](../../src/jobs/store.ts)), `F-02` (§2.6), `F-03`
(`GET /jobs/:id` carries **no authentication**,
[`src/server/routes/jobs.ts:5`](../../src/server/routes/jobs.ts)), `F-04`
(lexical `resolve()` equality with no `realpath`,
[`src/security/allowlist.ts`](../../src/security/allowlist.ts)), and `F-06`
(unversioned legacy state). `SF-15` gains a real admission gate. A
language-stable ingress contract becomes available for future non-Node agents.

**On the stated objective.** This milestone reduces AIBridge's own footprint by a
**measured 29%**, and that figure is a point estimate whose own baseline spread
(34.7%) makes it un-gateable in strict terms. It does **not** change the footprint
of `opencode serve`, the Bun runtime floor (~20 MiB), or `@opentui/core` (19 MB of
`node_modules`, in a separate process). A goal phrased as *drastically reduced
host footprint* is not met by this milestone alone; the dominant terms lie outside
it. This is recorded so the gate report cannot present the reduction as a
host-level result.

## 4. Language guardrail, amended

[`README.md:77`](../../Docs/implementation-plans/README.md) is replaced with:

> Do not add a second programming language unless a milestone plan explicitly
> changes this decision through an ADR. Rust is permitted under ADR 0008, within
> `router/` only, for ingress admission. The guardrail stands unchanged for
> `src/`.

`router/` is a separate Cargo workspace outside `src/`, excluded from the `tsc`
build and from the npm `files` allowlist in
[`package.json`](../../package.json). It has no upward import edge into `src/` and
`src/` acquires no dependency on it. Its boundary is JSON over a socket and the
committed schemas in `contracts/v1/`.

Per [`README.md:78`](../../Docs/implementation-plans/README.md), release, publish,
deployment, credential rotation, and node enrolment remain outside sub-agent
authority. This ADR does not grant any of them.

## 5. No message broker

Ingress durability is the **existing SQLite outbox, re-deployed for ingress**.
No broker — NATS, Redis, or any other — is introduced, and none is evaluated as
part of this milestone.

The decision rests on the problem already being solved in this repository.
[`src/mesh/outbox/`](../../src/mesh/outbox/) implements durable enqueue-before-transmit,
claim leases, `eventId` dedupe, the backoff table, the attempt threshold, retained
terminal records, an atomic ack commit, and `recoverStale` on restart — under
roughly twenty test files including `retry-convergence`, `crash-boundaries`, and
`stale-epoch`. §2.5 ports that policy rather than replacing it. A broker here would
be a second, less thoroughly tested implementation of a solved problem, plus:

1. **A second durable record of one fact.** A webhook would be persisted to the
   broker *and* to the SQLite event store, with no transaction spanning them. Two
   records that can disagree under any crash. §2.5 avoids this entirely.
2. **An unverifiable third contract.** Client-side dedupe state would exist in two
   languages, which is §2.3's drift risk in its worst form, with the broker's
   dedupe window as a contract nobody here owns.
3. **A register conflict.** A second durable delivery path contradicts ADR 0003
   (event store and idempotency) and ADR 0007 §17 ("delivery never affects
   orchestration state"). Adopting one would require reopening both.
4. **A third supervised process** for a two-node overlay, against a `systemd`
   memory cap (§2.7) that a broker's footprint would immediately violate.
5. **It would not address the stated failure.** "Zero data loss across regions
   during network partitions" presumes a multi-region topology. This deployment is
   two nodes over Tailscale; a per-node broker is a loopback bus. Genuine
   cross-region durability would need a clustered deployment with consensus — real
   operational surface for a topology that does not exist.

**What would reopen this.** A future milestone that introduces genuine
multi-region deployment, or many consumers per admitted item, would need to revisit
durable admission. This ADR is where that argument belongs. Until then
`src/mesh/outbox/` is the one durable-delivery implementation in this system, and
the invariant to preserve is that there is exactly one.

## 6. Statefulness boundary: two routes do not migrate

`GET /v1/mesh/terminal`
([`src/mesh/gateway/terminal/route.ts:216`](../../src/mesh/gateway/terminal/route.ts))
is a WebSocket with single-input-owner semantics (`SF-10`) and a manual takeover
protocol. `GET /v1/mesh/events`
([`src/mesh/gateway/events/route.ts:66`](../../src/mesh/gateway/events/route.ts))
is a long-lived SSE stream with snapshot re-base and cursor resume.

**A queue cannot be interposed between a peer and a stateful connection.** The
ownership token, the attach guard, and the resume cursor are all per-connection
state with no durable analogue in this milestone.

Both routes therefore **remain on the Bun process** in M7. Neither is currently
registered by `createApp()` — they are exercised only by test harnesses
(`tests/integration/mesh-fixtures.ts:360`) — so this costs nothing today. A test
must assert the router answers `404` for both paths and never `101` or a streaming
`200`, so a future migration cannot assume they moved.

Four stateless routes move: `GET /health`, `POST /trigger`, `GET /jobs/:id`,
`POST /report`.

## 7. The TUI stays decoupled

`aibr tui` ([`src/tui/bootstrap.ts:28`](../../src/tui/bootstrap.ts)) and
`aibr serve` are separate OS processes. Nothing under `src/tui/` imports
`src/jobs/`; the TUI's only recurring timer is a 100 ms terminal-output poller
([`src/tui/shell.ts:87`](../../src/tui/shell.ts)). It receives nothing from the
job engine, and that is correct: `SF-11` requires detach and TUI loss to preserve
node-owned sessions.

The worker does **not** drive the TUI render loop, and the TUI does **not**
subscribe to `ingress_outbox`. The TUI reads kernel projections exactly as it does
today. Wiring the worker to the render loop would reintroduce the coupling
milestone 3 deliberately removed.

Enforcement is a source-scan test asserting no import edge from `src/tui/**` to the
ingress queue or to `src/jobs/`, following the pattern already used by
`tests/unit/notifications/isolation.test.ts`. This test is the executable form of
§7 and exists because the coupling is the obvious "improvement" a future
contributor will attempt.

## 8. Binding to the Tailscale interface

Enforced in four independent layers, because each has a plausible single failure:

| Layer | Mechanism | Fails if |
| --- | --- | --- |
| Application | Bind the configured CGNAT address, never a wildcard; preflight verifies the address is on `tailscale0` and exits `78` (`EX_CONFIG`) otherwise | config drift |
| Kernel | `nft`: accept `iifname "tailscale0" tcp dport 8787`, drop all other `dport 8787` | `nft` not loaded |
| cgroup | `IPAddressDeny=any` + `IPAddressAllow=100.64.0.0/10` (systemd >= 235) | systemd < 235 |
| Overlay | Tailscale ACL restricting `:8787` to the two node tags | ACL misconfiguration |

`SO_BINDTODEVICE` is rejected in favour of explicit-address bind plus `nftables`
because it requires `CAP_NET_RAW`, which is a broader grant than this needs.

A negative test asserts ingress from a non-`tailscale0` interface is refused at all
four layers, and a second asserts the router exits `78` rather than binding when
the configured address is absent from the interface. Both are the kind of control
that regresses silently.

## 9. Verification obligations

**Contracts.** All 15 fixtures in `tests/contracts/examples/*.v1.json` parse
identically in both languages. Unknown-key rejection produces byte-identical `400`
bodies for the same fixtures across languages. `git diff --exit-code contracts/`
is clean after generation. A missing or unknown `schemaVersion` yields an explicit
refusal, never coercion.

**Durability.** Zero loss across 1000 kill/restart cycles. Zero duplicate
executions under `job_id` primary key plus `ON CONFLICT DO NOTHING`. A message
that fails on every attempt reaches terminal by attempt 8 within 127 s of backoff
and **remains readable** with its `terminal_error`. Router death before commit
yields `503`, zero rows, successful retry. Router death after commit and before
`202` converges on retry to one job. Worker death holding a claim requeues with
`attempts` preserved. Deleting the SQLite store makes the router exit `78` — there
is no in-memory fallback, which would silently drop admitted work.

**Backoff parity.** 16/16 golden vectors agree between the TypeScript and Rust
implementations, with the jitter deviation from §2.5 documented at the deviation
site.

**Security.** All four tailnet-bind layers refuse non-`tailscale0` ingress. A canary
bearer token appears in no log, diagnostic, or error body, following the audit
pattern in `tests/unit/notifications/no-secrets.test.ts`. `F-01` through `F-04` and
`F-06` are demonstrably closed at ingress, with the reproductions from
[`Docs/security/milestone-0-threat-model.md:100`](../security/milestone-0-threat-model.md)
as the acceptance corpus. No source scan finds an upward import edge from `router/`
into `src/`. The router answers `404` for both `/v1/mesh/*` paths.

**Resource.** Router RSS <= 4 MiB against `MemoryMax=32M`, reported as median and
p95 over >= 60 s. Three-process totals reported, never the router alone.

**Gate.** `bun run typecheck`, `bun test`, `bun run build`, `git diff --check`,
plus the router's own `cargo test`, `cargo clippy -- -D warnings`, and a
`cargo fmt --check`. Report filename `milestone-7-completion.md`, signed by the root
agent, the independent reviewer, and the security reviewer
([`README.md:113`](../../Docs/implementation-plans/README.md)).

## 10. Milestone renumbering

`Docs/implementation-plans/milestone-7-hardening-and-ecosystem.md` becomes
`milestone-8-hardening-and-ecosystem.md`, with its internal `M7.x` task IDs
renumbered `M8.x`. This milestone is inserted as **Milestone 7** and the
`README.md` index table gains the row between 6 and the renumbered 8.

Verified unstarted, so the renumbering is mechanical:
`Docs/implementation-reports/milestone-7-completion.md` does not exist, and no M7
source module exists. M8's stated prerequisite — "Milestones 0–6 have completion
reports" ([`README.md:11`](../../Docs/implementation-plans/README.md)) — is
unaffected.

Consequence for M8: its task **M8.5** ("Resource/load limits") is now the revisit
condition named in §2.4, and its **M8.9** ("Packaging/platform matrix") must cover
the router's five build targets in addition to the npm package.

## 11. Unresolved

- **Inter-component latency.** Admission adds one IPC hop. At 1800 s job timeouts
  this is not expected to matter, but end-to-end webhook-to-engine latency is a
  Phase 5 KPI precisely so the claim is measured rather than assumed.
- **`/v1/mesh/*` migration** is deferred with no milestone assigned. It needs a
  design for stateful ownership over a durable transport and should not be
  scheduled alongside stateless ingress work.
- ~~**Worker RSS is a projection, not a measurement.**~~ **CLOSED by M7.1, and the
  projection was wrong.** Measured 46.98 MiB against a projected 43.3 MiB (+8.5%);
  see §1 and [`milestone-7-router-spike.md`](../spikes/milestone-7-router-spike.md).
- **The baseline cannot be gated (R-M7.1-1).** Three captures of the unchanged
  engine under the §5.1.1 protocol spread 34.7% (62.1–86.1 MiB), so no percentage
  reduction can be claimed as a result until a baseline definition is found whose
  own spread is <=10%. M7.16 owns this.
- **The `<= 48 MiB` worker criterion is unresolvable by re-capture (R-M7.1-2).**
  Margin 1.02 MiB, spread 2.98 MiB. More samples could resolve it; more runs of
  the same length cannot.
- **The router's real RSS is unmeasured (R-M7.1-4).** The stub's 1.91 MiB has no
  SQLite or `sqlx`, so it is a lower bound. M7.5 adds the real cost.
- **Admission latency was never baselined.** No `opencode serve` is reachable on
  the reference host, so the §5.2 p50/p99 targets have no comparison point.
- **macOS parity.** `launchd` supervision is specified but untested. The reference
  host is macOS; the production node is Linux. If macOS parity cannot be tested to
  the same standard, that gap belongs in the gate report rather than in a footnote.
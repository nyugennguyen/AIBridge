# Milestone 8: Hardening and Ecosystem

## Objective

Prepare AIBridge for reliable external use through crash and corruption recovery, observability, diagnostics, resource limits, upgrade/rollback discipline, an adapter SDK and conformance kit, packaging validation, and an optional Herdr terminal-backend experiment.

This milestone is a release-hardening track. It does not weaken earlier gates or add providers merely to increase a compatibility count.

## Prerequisites

- Milestones 0–6 have completion reports; Milestone 7 has provisional progress sign-off (`Docs/implementation-reports/milestone-7-progress.md`) with five High security findings closed (`F-01`, `F-02`, `F-03`, `F-04`, `F-06`) and outstanding items bound to Milestone 8 as tracked technical debt (see §"Milestone 7 Carry-Forward").
- All persisted and wire formats have explicit versions.
- Supported operating limits can be measured using deterministic load/fault harnesses.
- Public extension points are limited to interfaces already proven by first-party implementations.

## Milestone 7 Carry-Forward

Milestone 7 introduced a second language and two new durable stores. These items are **owed** to this milestone, not merely noted by it. Source: `milestone-7-polyglot-ingress.md` §"Prerequisites Handed to Milestone 8" and [ADR 0008](../adr/0008-polyglot-ingress-and-admission.md) §11.

### Binding on existing tasks

| # | Item | Lands in | Note |
| --- | --- | --- | --- |
| **M7-C1** | `ingress_outbox` and `egress_outbox` integrity, backup, repair, and the retained-terminal-row evidence path. | M8.2 | Two new durable stores exist. "Outbox repair" in this plan's M8.2 deliverable means the mesh outbox **and** the M7 ingress/egress outboxes. Terminal rows are deliberately retained, so repair tooling must treat one as evidence and never delete it to "fix" a backlog. |
| **M7-C2** | Router signal family: admission rate, rejection reason, outbox depth/age, terminal-row count, bind-layer health. | M8.3 | The canary-token audit in M8.3 applies to the Rust router's `tracing` output as well as the TypeScript logs. A router that logs a request header leaks the node bearer token. |
| **M7-C3** | Router version, bind-preflight result, and outbox integrity status in the support bundle, without payload contents. | M8.4 | The bundle spans two processes and two languages now. "Recent redacted errors" must merge structured Rust spans with TypeScript log lines and preserve correlation IDs across them. |
| **M7-C4** | The five build targets for `aibr-router`. | M8.9 | M8.9 covers macOS and Debian/Ubuntu for the npm package. It must additionally clean-machine install, upgrade, and uninstall the router on both Linux arches, and verify `readelf -d` reports zero `NEEDED` on the musl targets. |
| **M7-C5** | Resource/load limits must cover the ingress path. | M8.5 | This task is also the **named revisit condition** for ADR 0008 §2.4's JSON-only serialization decision. It must measure whether any payload class's serialized size dominates ingress cost at documented supported load, then either confirm JSON or open a versioned binary-format contract. |
| **M7-C6** | `aibr-router` binary bound on `x86_64-unknown-linux-musl` (measured 2,222,768 bytes vs 2,097,152 bound; +125 KB overage). | M8.9 | M7 CI size gate fails on x86_64 due to bundled SQLite. M8.9 must resolve via an architectural decision: dynamic SQLite linkage on supported Linux distros, outbox store sidecar, or formal ADR 0008 §5 amendment. The bound remains unweakened until decided. |
| **M7-C7** | 1000-cycle kill/restart durability validation for `ingress_outbox`. | M8.2 / M8.1 | M7 crash matrix verified only 20 + 500 in-process cycles and 2 SIGKILL spawns. Full 1000-cycle kill/restart zero-loss verification under real process SIGKILL must be implemented and asserted in M8.2 recovery test harness. |
| **M7-C8** | Measured router steady-state RSS under sustained load with SQLite (`bench/mem.sh --all --samples 60`). | M8.5 | M7's −29.3% RSS reduction derived from M7.1's stub router without SQLite. M8.5 must capture true steady-state RSS under sustained load with SQLite WAL checkpoints and establish enforced resource caps. |
| **M7-C9** | `EgressOutboxStore` integration into live report callback pipeline. | M8.2 | F-02 credential leak is closed in-memory at header construction, but durable outbox delivery remains library-only (`src/callback/egress-outbox.ts`). M8.2 must wire durable egress outbox retry/drain into `src/callback/reporter.ts`. |
| **M7-C10** | Formal M7 multi-signature audit and M7.14 canary soak closure. | M8.10 | Milestone 7 progress report lacks formal 3-signature review (README §113), and M7.14 (canary rollout + 7-day soaks) was unattempted. M8.10 release candidate audit must absorb final soak verification and formal multi-sign-off. |

### Unassigned

| # | Item | Status |
| --- | --- | --- |
| **M7-U1** | Migration of `/v1/mesh/terminal` and `/v1/mesh/events` to the Rust ingress. | **Deliberately unassigned.** A queue cannot be interposed between a peer and a stateful connection; input ownership (`SF-10`) and SSE cursor resume have no durable analogue in M7. It needs its own design and its own milestone, not a slot in a release-hardening track. |
| **M7-U2** | macOS `launchd` supervision parity gap, if M7.16 could not test it to the same standard as Linux `systemd`. | **Open if M7.16 reports it.** Carried into M8.1's recovery runbooks and M8.9's platform matrix. |

### Standing constraints this milestone must not violate

- Rust is permitted **only** inside `router/`, only for ingress admission, under ADR 0008. The language guardrail is unchanged for `src/`. M8.7's SDK must not expose router internals; the ingress contract is JSON over a socket plus the committed schemas in `contracts/v1/`.
- The router is a **structural gate, never an authorization authority**. M8.1 and M8.10 must not "optimise" the worker's duplicate Zod re-parse away on the assumption that the Rust check already validated the payload.
- No broker may be introduced. ADR 0008 §5 records why, and names the topology change that would have to precede one.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M8.1 Failure-mode inventory and recovery runbooks | M0–M6 | `architect` — `gpt-6-astra high` | Recovery objectives and operator steps for process, disk, DB, migration, network, node, and controller failures | Tabletop exercises using packaged builds |
| M8.2 Database integrity, backup, and repair tooling | M8.1 | `subsystem-builder` — `gpt-5.6-sol high` | Check, backup, safe restore, projection rebuild, outbox repair, M7 ingress/egress outbox repair & pipeline integration (M7-C1/M7-C9), 1000-cycle kill/restart test (M7-C7), and unsupported-version diagnostics | Corruption corpus, interrupted-restore tests, and 1000-cycle zero-loss process kill/restart suite |
| M8.3 Structured observability | M8.1 | `feature-builder` — `gpt-5.6-terra high` | Redacted logs, metrics interface, trace/correlation fields, health/readiness, event-loop/storage/backlog signals | Golden logs contain required IDs and seeded secrets never appear |
| M8.4 Diagnostics bundle | M8.2–M8.3 | `feature-builder` — `gpt-5.6-terra high` | User-previewable support bundle with config shape, versions, health, recent redacted errors, and integrity status | Bundle schema and secret/path redaction tests |
| M8.5 Resource/load limits | M4–M6 | `test-engineer` + `subsystem-builder` — `gpt-5.6-sol high` | Benchmarks and enforced caps for nodes, sessions, events, buffers, artifacts, fan-out, queues, retention, and measured router steady-state RSS with SQLite under load (M7-C8) | Soak/load/flood tests establish documented supported limits; `bench/mem.sh --all --samples 60` |
| M8.6 Upgrade and rollback framework | M8.2 | `subsystem-builder` — `gpt-5.6-sol high` | Preflight, backup, ordered migrations, compatibility window, rollback boundary, and failure recovery | Upgrade from released fixtures; downgrade refusal/rollback tests |
| M8.7 Adapter and terminal SDK | Proven interfaces | `architect` + `feature-builder` — `gpt-6-astra high` / `gpt-5.6-terra high` | Public packages/types, lifecycle docs, sample adapter, conformance runner, compatibility policy | Sample third-party-style adapter passes without internal imports |
| M8.8 Herdr backend experiment | M8.7 | `feature-builder` — `gpt-5.6-terra high` | Time-boxed adapter spike and adopt/defer/reject ADR | No production dependency unless conformance and security gates pass |
| M8.9 Packaging/platform matrix | M8.2–M8.7 | `fixture-worker` + `test-engineer` — `gpt-5.6-luna medium` / `gpt-5.6-sol high` | npm package, installer, clean-machine setup/upgrade/uninstall tests for macOS and Debian/Ubuntu, router 5 build targets (M7-C4), and x86_64 2 MiB binary bound resolution (M7-C6) | Packed artifact smoke tests; no source-tree dependency; `readelf -d` clean; binary bound gate resolved |
| M8.10 Release candidate audit | All | `security-reviewer` + `independent-reviewer` — `gpt-6-astra xhigh/high` | Security, privacy, operations, API compatibility, release readiness report, and formal multi-sign-off with soak validation (M7-C10) | All release blockers resolved, acceptance suite passes twice from clean state, README §113 signatures on file |

## Recovery Requirements

Document and test recovery for:

- TUI crash while agents continue
- Node daemon crash before/after command persistence
- Controller crash before/after event commit
- SQLite WAL recovery and failed integrity check
- Corrupt projection with intact event log
- Corrupt/poison event or outbox item
- Disk full during append, artifact write, or migration
- Interrupted schema migration
- Lost/revoked worker and orphaned session
- Expired lease with unreachable nodes
- Unsupported newer config/database/protocol version
- **Ingress router** crash before admission commit, after commit but before the `202`, and while holding an outbox claim
- **`ingress_outbox` deleted or unreadable** — the router must exit `78`, not fall back to memory
- **`egress_outbox` destination unresolvable** — a terminal row retained with its `terminal_error`, never a credential sent to a forbidden origin
- **`ingress_mode` rollback** — reverting to `"engine"` mid-soak with admitted work still queued
- **Rust binary replaced by an incompatible build** — version stamp mismatch against the npm version

Repair tooling must be conservative: default to inspect and export; require an explicit backup before mutation; never fabricate events to make projections "look correct." This applies to the ingress and egress outboxes with the same force as to the event log, and a **terminal outbox row is evidence** — it must be exportable and reportable, never deleted to clear a backlog.

## Observability Contract

Structured logs use event names and stable fields rather than interpolated free text. Include relevant correlation IDs, project/run/task/dispatch/session IDs, node ID, controller epoch, adapter/backend kind, duration, and result category. Exclude prompts, terminal content, memory payloads, environment values, credentials, and raw sensitive paths by default.

Minimum operational signals:

- Node/controller health and lease time remaining
- Active sessions by normalized state
- Command inbox and event outbox depth/age
- Event append and projection latency
- Runtime adapter observation failures/unknown duration
- Terminal viewers, input owner, dropped frames, and buffer pressure
- Rule denials/approval backlog counts without sensitive payloads
- Storage size, artifact usage, retention backlog, and integrity status
- **Ingress:** admission rate, rejection reason counts, `ingress_outbox` depth and oldest-row age, `egress_outbox` depth, terminal-row count, and bind-preflight/bind-layer health

Router spans must carry the same correlation fields as the TypeScript logs — project/run/task/dispatch/session IDs, node ID, job ID — so a request is traceable from ingress to worker. A router span that omits the correlation ID, or that includes a request header, fails the M8.3 canary audit.

## SDK Boundary

The extension SDK exposes only stable contracts and test utilities:

- Runtime adapter interface and capability schema
- Terminal backend interface
- Sanitized process/terminal abstractions
- Conformance runner and deterministic fake scenarios
- Version compatibility declaration
- Error taxonomy and diagnostics contract
- Packaging and registration mechanism

Extensions do not receive the event-store connection, unfiltered environment, bearer/node private keys, arbitrary project paths, or policy bypass hooks. Registration is explicit and startup fails closed for incompatible SDK versions.

## Herdr Experiment

Time-box the experiment and evaluate:

- Mapping AIBridge terminal/session operations to Herdr workspace/tab/pane/agent primitives
- State-authority interaction with AIBridge runtime adapters
- Input ownership and remote attach behavior
- Recovery and identity mapping across restarts
- Version/API stability and distribution impact
- Security boundary and whether Herdr would need broader privileges

The result is an ADR. Shipping is optional and must not delay hardening. If adopted, Herdr remains a `TerminalBackend`; it cannot become a second orchestration source of truth.

## Release and Compatibility Policy

- Define supported previous versions for config, database, wire protocol, SDK, and adapters.
- Use expand/migrate/contract phases when a rolling mesh upgrade requires mixed versions.
- Refuse unsafe downgrades with an actionable message.
- Back up state before irreversible migration and verify the backup can be opened.
- Test installation from the packed artifact, not the repository checkout.
- Keep provider and terminal integrations capability-negotiated across minor versions.

## Completion Criteria

- Recovery runbooks succeed in tabletop and automated fault scenarios.
- Integrity checks distinguish recoverable projection damage from authoritative event damage.
- Diagnostics and logs pass seeded-secret and sensitive-content audits.
- Load tests establish and enforce published limits without unbounded queues/buffers.
- Upgrade from every declared supported version succeeds or fails safely with rollback guidance.
- Packed installation, setup, start, TUI, upgrade, and uninstall paths pass on macOS and Debian/Ubuntu.
- A sample external adapter/backend builds using only public SDK imports and passes conformance tests.
- Herdr has an explicit adopt/defer/reject decision backed by experiment results.
- All end-to-end acceptance scenarios pass twice from clean environments.
- Security and independent release reviews approve the candidate.

## Guardrails and Stop Conditions

- Do not build “repair” commands that delete or rewrite authoritative history by default.
- Do not include prompts, transcripts, secrets, or raw memory in diagnostics bundles.
- Do not publish an SDK around interfaces that changed during the last milestone review.
- Do not add an extension sandbox claim unless it is actually enforced and tested.
- Do not ship Herdr integration solely because the experiment works on one developer machine.
- Do not raise limits to make load tests pass; document or fix the bottleneck.
- Stop release for any unresolved blocker/high security issue, nondeterministic recovery, data-loss migration, or cross-project leak.
- Publishing, tagging, and deployment remain explicit user-controlled actions outside sub-agent authority.

## Gate Verification

```bash
bun test tests/recovery
bun test tests/security
bun test tests/load
bun run typecheck
bun test
bun run build
bun run release:check
git diff --check

# Ingress router (added by Milestone 7; ADR 0008)
cd router && cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

The final report includes supported limits, compatibility matrix, recovery exercise results, SDK version, packaging evidence, security findings, and the release decision. It must additionally record: the ADR 0008 §2.4 revisit decision from M8.5 (JSON confirmed or a versioned binary contract opened), ingress/egress outbox repair evidence, router build-target coverage from M8.9, and router signal coverage from M8.3. A release is not implied by plan completion; publishing requires separate user authorization.


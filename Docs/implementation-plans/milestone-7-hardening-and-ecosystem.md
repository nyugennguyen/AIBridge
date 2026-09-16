# Milestone 7: Hardening and Ecosystem

## Objective

Prepare AIBridge for reliable external use through crash and corruption recovery, observability, diagnostics, resource limits, upgrade/rollback discipline, an adapter SDK and conformance kit, packaging validation, and an optional Herdr terminal-backend experiment.

This milestone is a release-hardening track. It does not weaken earlier gates or add providers merely to increase a compatibility count.

## Prerequisites

- Milestones 0–6 have completion reports and no unresolved blocker/high security findings.
- All persisted and wire formats have explicit versions.
- Supported operating limits can be measured using deterministic load/fault harnesses.
- Public extension points are limited to interfaces already proven by first-party implementations.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M7.1 Failure-mode inventory and recovery runbooks | M0–M6 | `architect` — `gpt-6-astra high` | Recovery objectives and operator steps for process, disk, DB, migration, network, node, and controller failures | Tabletop exercises using packaged builds |
| M7.2 Database integrity, backup, and repair tooling | M7.1 | `subsystem-builder` — `gpt-5.6-sol high` | Check, backup, safe restore, projection rebuild, outbox repair, and unsupported-version diagnostics | Corruption corpus and interrupted-restore tests |
| M7.3 Structured observability | M7.1 | `feature-builder` — `gpt-5.6-terra high` | Redacted logs, metrics interface, trace/correlation fields, health/readiness, event-loop/storage/backlog signals | Golden logs contain required IDs and seeded secrets never appear |
| M7.4 Diagnostics bundle | M7.2–M7.3 | `feature-builder` — `gpt-5.6-terra high` | User-previewable support bundle with config shape, versions, health, recent redacted errors, and integrity status | Bundle schema and secret/path redaction tests |
| M7.5 Resource/load limits | M4–M6 | `test-engineer` + `subsystem-builder` — `gpt-5.6-sol high` | Benchmarks and enforced caps for nodes, sessions, events, buffers, artifacts, fan-out, queues, and retention | Soak/load/flood tests establish documented supported limits |
| M7.6 Upgrade and rollback framework | M7.2 | `subsystem-builder` — `gpt-5.6-sol high` | Preflight, backup, ordered migrations, compatibility window, rollback boundary, and failure recovery | Upgrade from released fixtures; downgrade refusal/rollback tests |
| M7.7 Adapter and terminal SDK | Proven interfaces | `architect` + `feature-builder` — `gpt-6-astra high` / `gpt-5.6-terra high` | Public packages/types, lifecycle docs, sample adapter, conformance runner, compatibility policy | Sample third-party-style adapter passes without internal imports |
| M7.8 Herdr backend experiment | M7.7 | `feature-builder` — `gpt-5.6-terra high` | Time-boxed adapter spike and adopt/defer/reject ADR | No production dependency unless conformance and security gates pass |
| M7.9 Packaging/platform matrix | M7.2–M7.7 | `fixture-worker` + `test-engineer` — `gpt-5.6-luna medium` / `gpt-5.6-sol high` | npm package, installer, clean-machine setup/upgrade/uninstall tests for macOS and Debian/Ubuntu | Packed artifact smoke tests; no source-tree dependency |
| M7.10 Release candidate audit | All | `security-reviewer` + `independent-reviewer` — `gpt-6-astra xhigh/high` | Security, privacy, operations, API compatibility, and release readiness report | All release blockers resolved and acceptance suite passes twice from clean state |

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

Repair tooling must be conservative: default to inspect and export; require an explicit backup before mutation; never fabricate events to make projections “look correct.”

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
```

The final report includes supported limits, compatibility matrix, recovery exercise results, SDK version, packaging evidence, security findings, and the release decision. A release is not implied by plan completion; publishing requires separate user authorization.


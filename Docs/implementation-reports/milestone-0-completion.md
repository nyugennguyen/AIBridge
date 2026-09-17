# Milestone 0 completion report

Date: 2026-09-17

Milestone: Architecture and migration contracts

Gate status: approved

## Scope delivered

Milestone 0 freezes the version-one, provider-neutral vocabulary and contracts needed by later AIBridge milestones. It delivers:

- A current-state inventory covering public and persisted legacy types, routes, state files, trust boundaries, and compatibility obligations.
- Canonical aggregate ownership and terminology for Mesh, Node, Project, Run, Task, Dispatch, Approval, Session, Role, Rule, Memory, Artifact, and Controller Lease.
- Strict Zod-first version-one schemas with inferred TypeScript types, distinct branded identifiers, typed errors, event/command unions, and deterministic dispatch-envelope digests.
- Provider-neutral runtime and terminal contracts with compiling fakes and conservative `unknown` behavior.
- SQLite/WAL event-ordering, transaction, idempotency, effect-journal, projection, lease-epoch, expiry, fencing, and manual-takeover decisions.
- A threat model with boundary ownership, testable safety-floor invariants, a security test backlog, and ranked findings.
- A deterministic, side-effect-free legacy migration dry run with explicit mappings, scoped identities, material mapping fingerprints, inert active-work imports, rollback documentation, and fail-closed diagnostics.
- Reusable deterministic contract helpers, conformance fakes, and fifteen canonical version-one JSON examples.

Intentionally deferred by the milestone guardrails: the TUI, a production event-store engine, live migration/cutover, HTTP/SSE/WebSocket orchestration protocols, runtime provider implementations, tmux/PTY behavior, automatic controller election, and any rewrite or deletion of current configs/jobs.

## Task execution and ownership

| Task | Owner | Model / effort | Result |
| --- | --- | --- | --- |
| M0.1 | `fixture-worker` | `gpt-5.6-luna medium` | Baseline and architecture inventory completed. |
| M0.2 | `architect` | `gpt-6-astra xhigh` | Canonical vocabulary, boundaries, names, and file layout frozen in ADRs 0001–0002. |
| M0.3 | `subsystem-builder` | `gpt-5.6-sol high` | Version-one orchestration schemas, types, errors, digest helpers, and schema tests completed. |
| M0.4 | `feature-builder` | `gpt-5.6-terra high` | Runtime and terminal contracts and focused contract fakes completed. |
| M0.5 | `architect` | `gpt-6-astra xhigh` | Event-store/idempotency and controller-lease/recovery ADRs completed. |
| M0.6 | `security-reviewer` | `gpt-6-astra xhigh` | Threat model completed; final bounded-contract security gate approved. |
| M0.7 | `subsystem-builder` | `gpt-5.6-sol high` | Legacy schemas, dry-run migration, fixtures, tests, and migration/rollback plan completed. |
| M0.8 | `feature-builder` | `gpt-5.6-terra high` | Deterministic harness, conformance fakes, and canonical examples completed. |
| M0.9 | `independent-reviewer` | `gpt-6-astra high` | Integrated audit completed; initial findings remediated and final gate approved. |

The root agent retained integration ownership, resolved the M0.4 terminal-fake audit defect, aligned the M0.1 path-security wording, added the final M0.7 canonical-conversion fail-closed boundary, and ran the milestone gate.

## Contract and schema versions

- Contract family: `aibridge.orchestration`.
- Persisted/API schema version introduced: literal `schemaVersion: 1`.
- Legacy source formats remain explicitly unversioned and are accepted only through `src/orchestration/legacy/schemas.ts`.
- Canonical examples: exactly fifteen `*.v1.json` records in `tests/contracts/examples/`.
- Dispatch approval binds to `sha256:` canonical-JSON digest of the complete immutable dispatch envelope.
- Runtime and terminal serialized values consume the same version-one canonical IDs and typed error taxonomy.

## Migration and rollback

The M0.7 planner is a pure dry run: it reads already-supplied values and performs no filesystem or database mutation. One legacy job maps to one Run, one Task, and one Dispatch; original job/task/session labels remain namespaced external references. Dependencies that would cross those per-job Runs remain compatibility evidence rather than invalid canonical Task edges. Existing active work imports as paused/inert and cannot resume without reconciliation, current authorization, a valid lease, and any required fresh approval.

Identity derivation includes stable source profile, legacy node, and legacy project scope. A separate fingerprint covers material authorization/configuration and canonical mapping inputs. Credential-bearing URLs, incomplete mappings, unsupported values, corrupt data, and canonical representability failures produce non-committable diagnostics without exposing credential values.

The documented future cutover requires source backups, an import journal, an atomic SQLite transaction, post-import verification, and source preservation. Rollback stops new orchestration effects, restores the pre-cutover store/selection, and leaves legacy source files unchanged. M0 does not implement or authorize live cutover.

## Security review and findings

The security reviewer approved the bounded M0 contract gate with no new unresolved Blocker or High finding in the M0 changes. The independent reviewer likewise approved after all eight audit findings were remediated.

The following threat-model findings remain open because they are pre-existing production obligations outside this contracts-only milestone:

| Finding | Disposition |
| --- | --- |
| F-01 legacy job-path traversal | High; do not expand affected production exposure. Remediate and test before the owning production gate. |
| F-02 callback credential forwarding | High; do not treat caller callback URLs as trusted credential destinations. Remediate before compatibility transport exposure. |
| F-03 unauthenticated legacy job query | High; require authenticated/authorized query behavior before remote production exposure. |
| F-04 lexical path check / symlink escape | High; enforce worker-side realpath containment immediately before process operations. |
| F-05 asserted legacy identity/approval | High; compatibility evidence never becomes canonical authenticated identity or approval authority. |
| F-06 unvalidated/corrupt persisted state | High; version, validate, back up, and fail visibly before live migration/cutover. |
| F-07 resource/redaction enforcement | Contract-stage limitation; enforce bounded payloads, artifacts, buffers, and redaction in owning implementation milestones. |

These findings are not rejected as false and are not claimed fixed. They are accepted as explicit constraints on later production work; M0 adds no production imports or expanded exposure. The migration planner and schemas enforce the corresponding contract-stage invariants where they have authority.

## Completion criteria evidence

| Criterion | Evidence |
| --- | --- |
| Canonical terms and aggregate ownership have no unresolved blockers | ADR 0001 defines every required term, identity, owner, lifecycle, legacy disambiguation, and downstream freeze; independent terminology review approved. |
| All new persisted/API shapes are versioned Zod schemas with inferred types | `src/orchestration`, `src/runtime`, and `src/terminal` schemas use strict literal-v1 Zod records; type modules infer/re-export their data types. |
| Runtime and terminal fakes compile | M0.4 and M0.8 fakes compile; conformance covers unsupported capabilities, `unknown`, dispatch deduplication, exact restore, read-only attachment, takeover, detach, and termination. |
| Event ordering, idempotency, lease epoch, and transaction semantics are explicit | ADRs 0003–0004 define per-Run sequence allocation, atomic append/receipt/projection/outbox boundaries, fingerprints, ambiguous effects, fixed authority, expiry, fencing, reconciliation, and takeover. |
| Safety floor is expressed as testable invariants | The threat model defines 17 non-overridable invariants and 22 milestone-owned security tests with validation/authentication owners. |
| Every current persisted format and endpoint has a migration/compatibility decision | M0.1 inventories config, secrets, job JSON, task Markdown, memory JSON, OpenCode state, and public routes; M0.7 documents keep/translate/deprecate/replace and rollback behavior. |
| Canonical fixtures round-trip; invalid fixtures fail deterministically | Fifteen examples round-trip; schema, migration, and conformance suites reject wrong versions, mismatches, unsafe values, credential URLs, duplicate effects, forged restores, and cross-project operations. |
| Full existing test, typecheck, and build suites pass | Final gate commands and results are recorded below. |
| Independent architecture and security reviews approve | M0.9 final recommendation: approve, with no remaining ranked finding. M0.6 final recommendation: approve the bounded M0 contract gate. |

## Guardrail evidence

- No TUI, production event-store engine, remote protocol, runtime provider, tmux/PTY implementation, or automatic election was added.
- Current configs and job files were neither deleted nor rewritten.
- Orchestration events contain normalized provider-neutral fields; provider metadata stays in runtime contracts.
- Legacy source authorization and exact allowlist evidence are preserved; unsafe or incomplete translation fails closed.
- The user-owned pre-existing untracked paths `.github/workflows/publish.yml` and `tests/unit/release/` were excluded from milestone write ownership.

## Verification

Final required gate:

```text
bun run typecheck
bun test tests/contracts
bun test
bun run build
git diff --check
```

Final results: typecheck passed; contract tests passed (**39 tests, 0 failures, 287 assertions**); full tests passed (**496 tests, 0 failures, 1,113 assertions across 35 files**); build passed; diff check passed.

## Known limitations

- M0 contracts and fakes do not prove production authentication, filesystem race resistance, SQLite durability, network-partition behavior, runtime recovery, terminal isolation, or secret detection.
- The legacy migration code is a planner, not a live migrator.
- Lease authority and event-store transaction behavior are decisions for implementation in later milestones, not operational code in M0.
- Existing legacy security findings F-01–F-07 remain release gates for affected production functionality.

## Milestone 1 prerequisites

Milestone 1 must consume, without redefining:

1. `aibridge.orchestration` schema version 1 and the distinct branded ID types.
2. The immutable `DispatchEnvelope` and canonical digest/approval binding.
3. The shared `ContractError`/`Result<T>` taxonomy.
4. `AgentRuntimeAdapter` and `TerminalBackend` contracts, including `unknown`, typed unsupported behavior, read-only default attachment, and single input ownership.
5. Project/path authority as a worker-side realpath-validated boundary; schema validity alone is never authorization.
6. Approval-before-dispatch by default and no authority inherited from legacy annotations.
7. Run-scoped fixed controller authority, epoch fencing, no automatic election, and no replay of ambiguous external effects.
8. The explicit F-01–F-07 security backlog for any legacy surface used by the vertical slice.

## Sign-off

- Root / milestone lead: **approved** — integrated scope, verification, and gate evidence reviewed.
- Independent reviewer (`gpt-6-astra high`): **approved** — all eight initial findings resolved; no remaining blocker/high/medium/low finding.
- Security reviewer (`gpt-6-astra xhigh`): **approved for the bounded M0 contract gate** — no new unresolved Blocker or High; F-01–F-07 carried forward as production obligations.

# Milestone 2: Multi-Runtime Adapter Layer

## Objective

Prove that AIBridge orchestrates capabilities rather than one provider by supporting OpenCode, Claude Code, and Codex through a single conformance-tested runtime interface. Each adapter must expose its confidence and limitations instead of manufacturing feature parity.

## Prerequisites

- Milestone 1 completes the local OpenCode TUI flow.
- `AgentRuntimeAdapter` and normalized lifecycle schemas are frozen from Milestone 0.
- The tmux backend can create, recover, and attach to local sessions.
- Test environments may omit real provider credentials; deterministic fake CLIs are mandatory.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M2.1 Adapter capability and conformance specification | M0–M1 | `architect` — `gpt-6-astra high` | Required/optional behaviors, confidence semantics, errors, and test matrix | Specification distinguishes unsupported, unknown, transient, and failed |
| M2.2 Provider-neutral adapter harness | M2.1 | `test-engineer` — `gpt-5.6-sol high` | Shared fake CLI, lifecycle script DSL, and conformance suite | A deliberately broken adapter fails each required invariant |
| M2.3 Extract and harden OpenCode adapter | M2.1–M2.2 | `feature-builder` — `gpt-5.6-terra high` | OpenCode SDK behavior fully behind runtime interface | Existing monitor/permission cases pass through conformance suite |
| M2.4 Claude Code adapter spike | M2.1 | `subsystem-builder` — `gpt-5.6-sol high` | Read-only discovery of supported CLI flags/hooks/session behavior and an ADR | Spike cites installed-version evidence; no guessed flags enter production |
| M2.5 Claude Code production adapter | M2.2, M2.4 | `feature-builder` — `gpt-5.6-terra high` | Detect, launch, prompt, observe, restore when supported, interrupt, terminate, collect result | Fake CLI conformance plus credential-free installed-binary smoke test |
| M2.6 Codex adapter spike | M2.1 | `subsystem-builder` — `gpt-5.6-sol high` | Discovery/notification/session ADR based on the installed Codex CLI | Version and capability evidence recorded; unsupported behavior explicit |
| M2.7 Codex production adapter | M2.2, M2.6 | `feature-builder` — `gpt-5.6-terra high` | Codex runtime adapter matching the shared lifecycle contract | Same conformance and smoke standards as Claude Code |
| M2.8 Runtime discovery and routing input | M2.3, M2.5, M2.7 | `feature-builder` — `gpt-5.6-terra high` | Installation probing, version/capability cache, health, and TUI selection | Missing/broken binaries cannot be selected; cache invalidation tested |
| M2.9 Cross-adapter adversarial review | All | `independent-reviewer` — `gpt-6-astra high` | Consistency and false-state findings | No adapter claims a capability it cannot demonstrate |

## Adapter Conformance Requirements

Every production adapter must implement or explicitly mark unsupported:

- Installation detection without executing arbitrary shell text
- Version and executable identity
- Launch with an allowlisted project directory and argv array
- Session reference persistence and recovery semantics
- Prompt submission with an idempotency boundary
- Lifecycle event observation with source and confidence
- Blocked/permission request representation
- Interrupt and terminate as separate operations
- Structured result collection or a declared fallback
- Sanitized diagnostics with no provider credentials or raw environment dump

Each capability report includes `supported`, `unsupported`, or `conditional`, plus evidence source such as API, hook, process state, terminal manifest, or user configuration.

## Lifecycle Normalization

Normalized states remain:

```text
starting → idle → working → blocked → working → completed
                     └───────────────→ failed
any non-terminal state ──────────────→ unknown
```

This diagram describes allowed observations, not guaranteed provider transitions. Adapters emit facts with confidence; a runtime coordinator applies conservative normalization.

Rules:

- Process exit zero is evidence, but completion still requires the adapter's declared result strategy.
- Silence, a shell prompt-looking line, or missing screen text is never sufficient for `completed`.
- `idle` means ready for input, not task success.
- `blocked` must include a reason or inspection reference when possible.
- After an observation source fails, report `unknown` and continue safe health checks; do not reuse the last state forever.
- Runtime-specific states are retained in metadata for diagnostics.

## Provider Tasks

### OpenCode

- Move `SdkOpencodeClientAdapter`, monitoring, and permission behavior behind the new interface without changing loopback binding.
- Prefer structured session status and permission events.
- Preserve SSE/poll fallback behavior, but expose which source produced each state.
- Translate OpenCode session IDs into runtime session references without treating them as AIBridge session IDs.

### Claude Code and Codex

- Inspect the installed CLI version and its own help/config documentation during implementation.
- Prefer documented hooks, structured output, notification, or resume features when available.
- Isolate version-specific command construction behind a tested strategy.
- Use terminal/process detection only as a conservative fallback.
- Do not install hooks or change a user's global CLI configuration without an explicit setup action and preview.
- Record whether AIBridge launched the session or merely discovered it; control operations differ for adopted sessions.

## Test Matrix

The shared harness covers:

- Binary absent, non-executable, wrong version, and slow version probe
- Clean launch, startup failure, and startup timeout
- One prompt delivered exactly once
- Working, idle, blocked, unknown, successful result, nonzero exit, crash, and forced termination
- Hook/event disconnect and fallback observation
- Restart with recoverable and unrecoverable session references
- Unexpected output, ANSI sequences, partial lines, Unicode, and oversized output
- Permission request with approve, deny, timeout, and unsupported structured reply
- Redaction of command arguments, environment, and diagnostics

## Completion Criteria

- All three adapters pass the same required conformance suite.
- Capability discovery is visible to routing and the TUI.
- Optional features are never assumed when absent.
- Ambiguous observations produce `unknown`, not idle/completed.
- Prompt idempotency is proven for retry at the adapter boundary.
- Installed-binary smoke tests require no provider login and make no remote model call.
- Existing OpenCode behavior and tests remain compatible.
- Independent review confirms no provider details leaked into orchestration-domain types.

## Guardrails and Stop Conditions

- Do not scrape private provider files or undocumented credential stores.
- Do not commit assumptions about CLI flags without installed-version or official documentation evidence.
- Do not require users to modify global Claude Code/Codex configuration during normal launch.
- Do not auto-approve provider permission prompts.
- Do not equate terminal readability with lifecycle reliability.
- Stop an adapter task if deterministic prompt idempotency cannot be established; mark it experimental rather than shipping unsafe retry.
- Keep real-provider tests opt-in and credential-free unless separately authorized.

## Gate Verification

```bash
bun test tests/contracts/runtime
bun test tests/unit/runtime
bun test tests/integration/runtime-adapters.test.ts
bun run typecheck
bun test
bun run build
git diff --check
```

The completion report includes a per-provider capability table, tested CLI versions, observation confidence sources, and all experimental limitations.


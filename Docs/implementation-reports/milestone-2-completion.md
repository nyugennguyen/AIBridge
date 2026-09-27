# Milestone 2 Completion Report: Multi-Runtime Adapter Layer

Completion date: 2026-09-27

Status: **COMPLETE**

## 1. Scope Delivered

Milestone 2 delivers a unified, conformance-tested multi-runtime adapter layer supporting **OpenCode**, **Claude Code**, and **Codex** across the AIBridge mesh without fabricated feature parity:

- **Provider-Neutral Adapter Interface & ADRs**: Formalized provider-neutral contract (`AgentRuntimeAdapter`) with explicit capability reporting (`AdapterCapabilityReport`). Authored ADR 0005 (Claude Code Runtime Adapter) and ADR 0006 (Codex Runtime Adapter).
- **Reusable Adapter Conformance Test Harness**: Implemented 11-rule automated conformance test suite, flaw-injection harnesses catching false success and boundary violations, stream adversity tests handling split ANSI/Unicode/JSON lines, and a scripted lifecycle DSL.
- **Hardened OpenCode Adapter**: Validates literal-loopback bindings (`127.0.0.1`, `[::1]`), enforces prompt policy intersection, distinguishes SSE vs polling provenance, and treats idle sessions as `outcome: "unknown"` absent reliable completion evidence.
- **Process Containment & Credential Sanitization**: Implemented `sanitizeChildProcessEnv` (scrubbing internal tokens and passwords while passing selective API keys), `redactSecretsFromText` (pattern scrubbing API keys and bearer tokens), and `isPathContained` (preventing directory traversal outside project bounds).
- **Production Claude Code Adapter**: Headless execution with direct argv arrays, discrete signal separation (`SIGINT` for interrupt, `SIGTERM` + `SIGKILL` timeout for terminate), session restore via `-r <session_id>`, and zero-exit degradation to `unknown` when structured completion events are omitted.
- **Robust Line & JSON Stream Parser**: ANSI escape stripping across chunk boundaries, multi-byte UTF-8 continuity, and bounded memory allocation (64KB line cap).
- **Production Codex Adapter**: Non-interactive headless exec mode with structured event parsing, native session resume via `codex exec resume <handle>`, and fail-closed handling for interactive permission RPCs.
- **Multi-Runtime Discovery & Routing Service**: Isolated, non-blocking binary probing with bounded timeouts (`2000ms`), cache invalidation keyed on `path`, `mtimeMs`, and `size`, routing guardrails with actionable runtime availability errors, and aggregated `detect(nodeContext)`.
- **Full Vertical Slice Conformance**: Integration test suite verifying multi-runtime capability extraction, end-to-end dispatch routing, and degraded outcome semantics across all three providers.

---

## 2. Task and Sub-Agent Execution

Execution proceeded according to the Milestone 2 implementation plan under continuous adversarial oversight by the dedicated Lead Advisor & Reviewer subagent (`advisor_reviewer`, ID `64b3803e-0e55-4da1-b26d-b3304d0eea54`).

| Task | Module / Deliverable | Status | Advisor Review Disposition |
| :--- | :--- | :---: | :--- |
| **M2.1** | Adapter Specification & ADRs (`ADR-0005`, `ADR-0006`, `AdapterCapabilityReport`) | **COMPLETE** | Formal Sign-Off: Agnostic core schemas, explicit capability models, zero leaked provider semantics. |
| **M2.2** | Provider-Neutral Adapter Harness (`conformance-suite.ts`, flaw injection, stream adversity, lifecycle DSL) | **COMPLETE** | Formal Sign-Off: Strict invariant verification, adversarial test coverage for state fabrication. |
| **M2.3** | OpenCode Adapter Hardening (`OpencodeRuntimeAdapter`, loopback checks, policy intersection) | **COMPLETE** | Formal Sign-Off: Conformance pass, idle degraded to `unknown`, loopback safety verified. |
| **M2.4** | Process Containment & Sanitization (`sanitizer.ts`, `sanitizeChildProcessEnv`, `redactSecretsFromText`, `isPathContained`) | **COMPLETE** | Formal Sign-Off: Zero credential leakage, strict containment, safe subpath isolation. |
| **M2.5** | Claude Code Adapter (`ClaudeCodeRuntimeAdapter`, JSONL streaming, discrete argv, signal separation) | **COMPLETE** | Formal Sign-Off: Direct argv arrays, exit 0 degraded to `unknown`, full conformance suite pass. |
| **M2.6** | Stream Parser & Sanitizer (`LineStreamSplitter`, `safeParseJsonLine`, ANSI boundary handling) | **COMPLETE** | Formal Sign-Off: Chunk assembly, multi-byte UTF-8 resilience, memory bounded at 64KB. |
| **M2.7** | Codex Adapter (`CodexRuntimeAdapter`, headless exec, session resume, fail-closed permissions) | **COMPLETE** | Formal Sign-Off: Strict fail-closed permissions, resume via handle, full conformance pass. |
| **M2.8** | Multi-Runtime Discovery & Routing (`RuntimeDiscoveryService`, health check isolation, cache invalidation) | **COMPLETE** | Formal Sign-Off: Isolated probing, `mtime`/`size` cache invalidation, routing guardrails. |
| **M2.9** | Cross-Adapter Adversarial Review & Full Gate Verification (`tests/integration/runtime-adapters.test.ts`) | **COMPLETE** | Formal Sign-Off: Full vertical slice passed, 0 critical/major findings, all gate checks passed. |

---

## 3. Safety Guardrails & Contract Audit

| Guardrail / Invariant | Status | Enforcement Mechanism |
| :--- | :---: | :--- |
| **No Leaked Provider Semantics** | **PASSED** | Core schemas (`Project`, `Run`, `Dispatch`, `Session`, `AgentResult`) contain zero provider-specific fields. Provider identifiers remain isolated in `adapterMetadata.handle`. |
| **Credential Scrubbing** | **PASSED** | `sanitizeChildProcessEnv` removes `AIBRIDGE_*`, bearer tokens, `*_SECRET`, `*_PASSWORD`, `*_AUTH`, and `*_KEY` before child process spawn. `redactSecretsFromText` scrubs tokens from stdout/stderr/error messages. |
| **Path Traversal Containment** | **PASSED** | `isPathContained` strictly checks relative directory containment to guarantee execution occurs within authorized project boundaries. |
| **Subshell Invocation Prohibition** | **PASSED** | Direct argv execution arrays used exclusively (`execFileAsync` and `spawn`). Subshell invocation (`sh -c`, `bash -c`) is completely eliminated. |
| **Prompt & Command Idempotency** | **PASSED** | Exact duplicate command ID submissions return cached results (`Result<RuntimeSession>` for launch, `{ ok: true, value: undefined }` for prompt). Altered payloads return `conflict`. |
| **Anti-Fabrication Lifecycle Rigor** | **PASSED** | Exit code 0 without verified structured result payload degrades to `outcome: "unknown"` with provenance `source: "process_state", confidence: "observed"`. Idle state is never upgraded to `succeeded`. |
| **Separate Control Boundaries** | **PASSED** | `interrupt` (`SIGINT` non-destructive cancel) and `terminate` (`SIGTERM` + 3000ms grace period + `SIGKILL` cleanup) are cleanly decoupled across all adapters. |

---

## 4. Multi-Runtime Capability Matrix

The three supported runtimes provide distinct operational capabilities without artificial feature emulation:

| Feature / Capability | OpenCode (`1.18.32`) | Claude Code (`2.1.138`) | Codex (`0.155.1`) |
| :--- | :--- | :--- | :--- |
| **Execution Architecture** | Local HTTP/SSE loopback server (`4096`) | Headless CLI subprocess (`claude -p`) | Headless CLI subprocess (`codex exec`) |
| **Structured Permissions** | **Supported** (Interactive HTTP RPC) | **Conditional** (Projected `false` in core) | **Unsupported** (Headless exec mode) |
| **Native Session Restore** | **Unsupported** (Inspect-only tmux handle) | **Supported** (`claude -r <session_id>`) | **Supported** (`codex exec resume <handle>`) |
| **Reliable Completion Evidence** | **Unsupported** (Degrades idle to `unknown`) | **Supported** (Structured JSONL `result`) | **Supported** (Structured JSONL `turn.completed`) |
| **Model Selection** | **Unsupported** (Fixed server model) | **Supported** (`--model <model>`) | **Supported** (`-m <model>`) |
| **Usage Data Reporting** | **Unsupported** (Unavailable via current SDK) | **Supported** (Parsed from stream metrics) | **Supported** (Parsed from stream metrics) |
| **Event Hooks** | **Unsupported** (Loopback SSE stream only) | **Supported** (`--include-hook-events`) | **Unsupported** (Stdout JSONL streaming) |
| **Transcript Export** | **Unsupported** (Terminal snapshot fallback) | **Unsupported** (Terminal snapshot fallback) | **Unsupported** (Terminal snapshot fallback) |

---

## 5. Observation Confidence & Provenance Mapping

Every lifecycle event emitted by the runtime adapter layer carries explicit evidence source and confidence annotations:

| Event Type / Trigger | Emitted Lifecycle State | Evidence Source | Confidence Level | Fallback Behavior |
| :--- | :--- | :--- | :--- | :--- |
| OpenCode SSE `session.status` | `working` / `idle` | `hook` | `authoritative` | Degrades to polling |
| OpenCode Polling Fallback | `working` / `idle` | `polling` | `inferred` | Degrades to `unknown` on transport error |
| OpenCode Permission Event | `permission_requested` | `api` | `authoritative` | Bounded to dispatch envelope |
| Claude JSONL `system` / `progress` | `working` | `hook` | `authoritative` | Degrades to `unknown` on disconnect |
| Claude JSONL `result` (success) | `completed` | `hook` | `authoritative` | Produces `CompletionEvidence` |
| Claude JSONL `permission_request` | `permission_requested` | `hook` | `authoritative` | Responded via stdin NDJSON |
| Codex JSONL `turn.started` | `working` | `hook` | `authoritative` | Degrades to `unknown` on disconnect |
| Codex JSONL `turn.completed` (success) | `completed` | `hook` | `authoritative` | Produces `CompletionEvidence` |
| Process Exit Code 0 without Result | `unknown` | `process_state` | `observed` | Never marked `completed` |
| Process Exit Code != 0 / Crash | `failed` | `process_state` | `observed` | Redacts raw error details |
| Stream Interruption / Inactivity Timeout | `unknown` | `process_state` | `tentative` | Health probe continues |

---

## 6. Accepted Limitations & Boundaries

1. **OpenCode**: Completion cannot be reliably deduced from loopback server idle status alone; idle sessions degrade to `outcome: "unknown"` absent authoritative verification evidence. Native session restore across process restart is inspect-only through tmux session handles.
2. **Claude Code**: Interactive permission responses are marked `conditional` because they depend on bidirectional NDJSON over `stdin` in print mode (`-p`). For orchestration safety, this capability is conservatively projected to `false` in `capabilities.structuredPermissions`.
3. **Codex**: Codex CLI in non-interactive `exec` mode does not support bidirectional interactive permission RPC. Dispatches requiring live approvals must not be routed to Codex; permissions must be pre-approved via sandbox policies (`-s workspace-write` or `-s read-only`). Calling `respond()` fails closed with `unsupported_capability`.

---

## 7. Verification Gate Evidence

The complete verification gate was executed and passed cleanly:

```bash
bun test tests/contracts/runtime
# 30 passing contract tests across 5 files (0 failures)

bun test tests/unit/runtime
# 72 passing runtime unit tests across 4 files (0 failures)

bun test tests/integration/runtime-adapters.test.ts
# 5 passing multi-runtime vertical integration tests (0 failures)

bun run typecheck
# tsc -p tsconfig.json --noEmit: Clean (0 errors)

bun test
# 675 passing tests across 55 files (2 opt-in skips, 0 failures)

bun run build
# Clean compilation to dist/

git diff --check
# Clean (0 whitespace/conflict errors)
```

---

## 8. Sign-Off & Transition

- **Milestone Integration**: **PASS**
- **Lead Advisor & Reviewer**: **PASS & FORMALLY SIGNED OFF**
- **Status**: Milestone 2 goals are fully satisfied. The codebase is ready for **Milestone 3: Tailscale Mesh & Distributed State Store**.

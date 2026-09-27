# Milestone 2: Adapter Capability and Conformance Specification

Status: Frozen for Milestone 2 implementation; verified by M2.9 gate review.

Scope: Universal contract specifications, lifecycle normalization rules, capability reporting, error mappings, prompt idempotency boundaries, and verification test matrix for all AIBridge runtime adapters (`opencode`, `claude`, `codex`).

---

## 1. Domain Separation and Adapter Boundary

AIBridge orchestrates capabilities across heterogenous coding agents without manufacturing false feature parity or leaking provider-specific concepts into core orchestration domains.

1. **No Leaked Semantics**: Top-level orchestration types (`Project`, `Run`, `Task`, `Dispatch`, `Approval`, `Session`, `AgentResult`) remain provider-agnostic. Proprietary tokens, provider session formats, and proprietary CLI flags are encapsulated within each adapter.
2. **Provider Identifiers vs AIBridge Identifiers**: Provider-assigned session handles (e.g., OpenCode session IDs, Claude Code UUIDs, Codex thread IDs) are persisted solely as `RuntimeSessionReference.adapterMetadata.handle` or adapter-private state. They are never conflated with AIBridge `SessionId`.
3. **Loopback & Process Isolation**:
   - Web-based adapters (OpenCode) must strictly bind to loopback (`127.0.0.1` or `[::1]`) and reject remote endpoints.
   - CLI-based adapters (Claude Code, Codex) must be executed using explicit argv arrays (`[executable, ...args]`), never via a shell interpreter (`sh -c`).
   - Project roots must be allowlisted before launch; directory traversal outside the configured project path is rejected with `policy_denied`.

---

## 2. Capability Matrix and Evidence Semantics

Capabilities must never be fabricated. Every capability report explicitly declares support level and evidence source.

### 2.1 Capability Status
- `supported`: Capability is natively implemented and verified by the provider interface.
- `unsupported`: Capability is not available in the installed version; caller must use declared fallback.
- `conditional`: Capability is available only under specific conditions (e.g., user flags, local sandbox permissions, specific binary version).

### 2.2 Evidence Sources
- `api`: Authoritative structured RPC/REST response or programmatic SDK callback.
- `hook`: Structured event stream emitted by runtime hooks or CLI streaming output.
- `process_state`: Operating system process lifecycle (exit code, signals, PID liveness).
- `terminal_manifest`: Bound terminal session metadata or output capture.
- `user_config`: Explicit node-level or profile configuration.

### 2.3 Projection to Frozen RuntimeCapabilities Schema
For backwards compatibility with Milestone 0/1 orchestration schemas:
- Rich adapter declarations use `AdapterCapabilityReport` (`structuredPermissions`, `nativeSessionRestore`, etc., each having `{ status: CapabilitySupportStatus, evidenceSource: CapabilityEvidenceSource, detail?: string }`).
- The frozen `RuntimeCapabilities` schema (which requires strict boolean values) is projected conservatively using `capabilityReportToRuntimeCapabilities`:
  - `status === "supported"` projects to `true`.
  - `status === "conditional"` or `status === "unsupported"` projects to `false`.
  This guarantees that orchestration components never assume an unverified or conditional capability is unconditionally available.

### 2.4 Capability Definitions
| Capability Key | Meaning when `supported` | Fallback when `unsupported` |
| --- | --- | --- |
| `structuredPermissions` | Runtime emits typed permission requests and waits for programmatic `allow`/`deny` response. | Blocked state requires manual user terminal interaction or conservative denial. |
| `nativeSessionRestore` | Runtime can reconnect to an existing session handle across process restarts. | Session recovery is inspect-only through terminal backend; no prompt replay. |
| `reliableCompletion` | Provider signals explicit completion with verified structured result. | Result is inferred as `unknown` unless verified by trusted external evidence. |
| `modelSelection` | Adapter can configure the underlying model via launch parameters. | Adapter uses provider default model. |
| `usageData` | Adapter reports token usage and cost metrics. | Omitted from result metadata. |
| `hooks` | Adapter can register or listen to runtime lifecycle hooks. | Polling and process observation fallback. |
| `transcriptExport` | Adapter can export full conversation or action log. | Bounded terminal history or null transcript. |

---

## 3. Normalized Lifecycle State Transitions

Adapters observe provider facts and normalize them into the canonical state machine:

```text
         ┌───────────────┐
         │   starting    │
         └───────┬───────┘
                 │
                 ▼
         ┌───────────────┐       (prompt)       ┌───────────────┐
         │     idle      ├─────────────────────►│    working    ├───┐
         └───────▲───────┘                      └───┬───────▲───┘   │
                 │                                  │       │       │
                 │         (permission req)         ▼       │       │
                 │       ┌──────────────────────────────┐   │       │
                 └───────┤           blocked            ├───┘       │
                         └──────────────────────────────┘           │
                                                                    │
                 ┌──────────────────────────────────────────────────┘
                 │
                 ├─────────────────────────────► completed
                 │
                 └─────────────────────────────► failed

    (Any non-terminal state upon ambiguity / disconnect) ──► unknown
    unknown ──► working (when verified active progress resumes)
    unknown ──► idle (when verified waiting for input)
    unknown ──► failed (upon process termination or fatal probe failure)
```

### Invariants:
1. `idle` means ready for new input, **never** task success or completion.
2. `working` indicates active reasoning or tool execution.
3. `blocked` must provide an inspectable reason or permission description.
4. Process exit code 0 is **necessary but not sufficient** for `completed`. A clean exit without verified task completion result must be marked `unknown` or `failed` depending on declared adapter strategy.
5. Silence, prompt string detection, or missing screen output is **never** evidence of `completed`.
6. When an observation source disconnects or emits unparseable data, the state transitions to `unknown` while maintaining health monitoring; it must **never** latch the previous state indefinitely.
7. Outgoing transitions from `unknown`:
   - `unknown -> working`: A subsequent valid authoritative or observed progress event arrives.
   - `unknown -> idle`: Provider explicitly reports waiting for next user instruction.
   - `unknown -> failed`: Child process terminates or heartbeat probe fails definitively.

### Observation Confidence Levels:
- `authoritative`: Direct programmatic event from provider API or structured streaming event.
- `observed`: Verifiable process termination, exit code, or explicit terminal output pattern.
- `inferred`: Derived from inactivity or heartbeat timeouts (must be conservative).
- `tentative`: Preliminary observation awaiting confirmation.

---

## 4. Prompt Idempotency and Boundaries

Adapters enforce deterministic prompt execution boundaries:
1. **At-Most-Once Delivery per Command ID**:
   - Each `launch` and `prompt` request includes a `RuntimeOperationContext` with an immutable `commandId`.
   - Repeated submission of the exact same `commandId` and payload returns:
     - For `launch`: The cached `Result<RuntimeSession>` without duplicate execution side effects.
     - For `prompt`: Acknowledgement `{ ok: true, value: undefined }` without duplicate submission.
   - Reusing a `commandId` with different prompt content or parameters returns `ContractError` with category `conflict` (`runtime.launch.command_conflict` or `runtime.prompt.command_conflict`).
2. **Dispatch Single-Binding**:
   - A single dispatch (`dispatchId`) can bind to at most one runtime session. A fresh command ID targeting an already-bound dispatch is rejected (`runtime.launch.dispatch_already_bound`).

---

## 5. Control Operations: Interrupt vs Terminate

Adapters must implement `interrupt` and `terminate` as separate, distinct operations:
- `interrupt`: Non-destructive cancellation of current task/prompt (e.g. `SIGINT`, SDK abort signal, abort endpoint). The session remains alive and transitions to `idle` or `failed` (cancelled), ready for inspection or subsequent commands.
- `terminate`: Destructive teardown of the session process tree and resources (e.g. `SIGTERM`, followed by grace period `DEFAULT_TERMINATION_GRACE_PERIOD_MS = 3000ms`, then `SIGKILL`, closing tmux pane/session). The session transitions to terminal `failed` or closed.

---

## 6. Diagnostic and Error Sanitization

All adapter outputs, errors, and metadata are strictly sanitized:
1. **Credential Hygiene**:
   - **Internal AIBridge Secrets**: Bearer tokens, cluster keys, and `AIBRIDGE_*` secrets are strictly stripped from all child process environments, diagnostics, and logs.
   - **Provider API Keys**: Configured provider keys (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are passed only to the child process environment when required for execution, but are strictly redacted from logs, error messages, diagnostics, and metadata.
   - Metadata keys matching `/(?:credential|password|secret|token)/i` are rejected at schema validation.
2. **Path Sanitization**:
   - Relative paths containing `..` escaping the project boundary are rejected.
   - Symlinks pointing outside allowlisted directories are prohibited.
3. **Error Taxonomy Mapping**:
   Provider-specific error codes must be mapped to standard `ContractErrorCategory`:
   - `validation`: Malformed request, invalid schema, illegal parameter.
   - `conflict`: Command duplicate with differing payload, duplicate dispatch binding.
   - `policy_denied`: Scope mismatch, unallowlisted project path, unauthorized permission decision.
   - `unsupported_capability`: Requested runtime feature not supported by installed binary.
   - `runtime_failure`: Process launch failure, exit code error, unhandled provider fault.
   - `timeout`: Probe timeout, execution deadline expired, unresponsive process.

---

## 7. Conformance Test Matrix

Every runtime adapter must pass the universal test harness:

| Category | Test Invariant | Verification Check |
| --- | --- | --- |
| Detection | Binary absent / non-executable | Returns empty array or safe `unsupported_capability`, no crash. |
| Detection | Version probe timeout (≤ 2000ms) | Times out gracefully, returns empty installation. |
| Detection | Safe execution | Uses direct argv, never runs shell string. |
| Launch | Allowlisted project path | Rejects foreign path with `policy_denied`. |
| Launch | Exact command deduplication | Identical launch request returns cached session; side effect count = 1. |
| Launch | Conflicting command ID | Changed payload with same command ID returns `conflict`. |
| Launch | Dispatch re-binding | Re-launching bound dispatch with new command ID returns `conflict`. |
| Restore | Valid session handle | Restores exact known session matching project and dispatch. |
| Restore | Unknown / forged handle | Rejects unknown session with `policy_denied`. |
| Restore | Project scope violation | Foreign project operation rejected with `policy_denied`. |
| Prompt | Exact prompt deduplication | Duplicate prompt returns `{ ok: true, value: undefined }` without second submission. |
| Prompt | Conflicting prompt command ID | Returns `conflict`. |
| Observe | Streaming normalization | Maps lifecycle events (`idle`, `working`, `blocked`). |
| Observe | Confidence provenance | Lifecycle events attach `source` and `confidence`. |
| Observe | Disconnect handling | Stream interruption yields `unknown`, does not fabricate `completed`. |
| Observe | Outgoing from unknown | Recovery from unknown to `working`, `idle`, or `failed` is verified. |
| Observe | Stream adversity | Handles partial lines, ANSI escapes, multi-byte Unicode, burst buffer. |
| Respond | Permission mapping | Valid permission response forwarded to provider; unauthorized denied. |
| Control | Interrupt vs Terminate | `interrupt` stops work keeping session; `terminate` cleans up process. |
| Result | Completion rigor | Exit 0 without completion evidence reports `unknown`, not `succeeded`. |
| Result | Failure collection | Non-zero exit or error reports `failed` with bounded summary. |
| Security | Secret redaction | Sanitized diagnostics omit tokens, keys, and raw env dumps. |

# ADR 0005: Claude Code Runtime Adapter Architecture and Discovery Spike

Status: Proposed / Accepted for Milestone 2 implementation
Date: 2026-09-27
Deciders: Core Architecture Team, Advisor & Reviewer

## Context

AIBridge requires multi-runtime support for local AI coding agents. Claude Code is a primary target. To avoid brittle reverse-engineering or hypothetical flags, this architecture is grounded in empirical verification of installed Claude Code (`2.1.138`).

### Empirical Verification Evidence
Inspecting the installed binary `/Users/mac/.local/bin/claude` (`2.1.138 (Claude Code)`):
1. **Version probe**: `claude --version` prints `2.1.138 (Claude Code)`.
2. **Headless Execution**: `-p, --print` runs non-interactively without TTY prompts, skipping the interactive trust dialog when stdout is redirected.
3. **Structured Streaming**:
   - `--output-format stream-json`: Emits newline-delimited JSON events over stdout.
   - `--input-format stream-json`: Ingests newline-delimited JSON commands over stdin for bidirectional interaction in print mode.
   - `--include-hook-events`: Emits hook lifecycle events into the stream.
4. **Session Control**:
   - `--session-id <uuid>`: Enforces a deterministic UUID for session correlation.
   - `-r, --resume <uuid>`: Resumes an existing session by UUID.
   - `--no-session-persistence`: Disables local session state saving when ephemeral isolation is requested.
5. **Tool & Capability Sandboxing**:
   - `--tools <tools...>`: Restricts available built-in tools (e.g. `Bash,Edit,Read`).
   - `--disallowed-tools <tools...>`: Explicit tool denylist.
   - `--permission-mode <mode>`: Supports `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`.
   - `--model <model>`: Explicit model selection.
   - `--system-prompt <prompt>`: Role and boundary injection.

## Decision

1. **Non-Invasive Execution Model**:
   - AIBridge executes Claude Code via direct argv spawning without modifying global `~/.claude.json` or local `.claude/` project configurations.
   - Project directory is passed as the child process `cwd` within the allowlisted project boundary.
2. **Session Identification & Resumption**:
   - AIBridge generates a canonical UUID v4 for each launch and passes `--session-id <uuid>`.
   - The UUID is stored in `RuntimeSessionReference.adapterMetadata.handle`.
   - `restore` uses `-r <uuid>`.
3. **Observation & Bidirectional Stdin Protocol**:
   - Launches spawn child process with argv:
     `[claudePath, "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--include-hook-events", "--session-id", sessionId, ...extraArgs]`
   - Adapter consumes stdout as JSON Lines:
     - `system` / `init` events map to `working`.
     - Tool calls / reasoning map to `working`.
     - Permission prompts in stream map to `blocked` with typed request ID.
     - Final `result` message indicates task completion with structured summary.
   - Follow-up prompts and permission responses are serialized as NDJSON objects and written to the child process's open `stdin` stream:
     - Prompt: `{"type": "user_message", "message": promptText}\n`
     - Response: `{"type": "permission_response", "request_id": id, "decision": decision}\n`
   - If the process exits 0 without a verified `result` message, the session outcome degrades to `unknown`.
   - Process crashes or non-zero exit codes map to `failed`.
4. **Control Boundaries**:
   - `interrupt` sends `SIGINT` to the child process.
   - `terminate` sends `SIGTERM`, waiting up to `DEFAULT_TERMINATION_GRACE_PERIOD_MS` (3000ms) before sending `SIGKILL`.
5. **Idempotency**:
   - Prompt requests are deduplicated by `commandId`. Re-sending an identical command returns `{ ok: true, value: undefined }`; conflicting prompt payloads return `conflict`.
6. **Capability Declarations**:

| Capability | Status | Evidence Source | Detail / Fallback |
| --- | --- | --- | --- |
| `structuredPermissions` | `conditional` | `hook` | Stream permission events supported via bidirectional stdin; projected to `false` in boolean schema for safety. |
| `nativeSessionRestore` | `supported` | `process_state` | Resumed via `-r <uuid>`. |
| `reliableCompletion` | `supported` | `hook` | Emits structured `result` payload in stream-json. |
| `modelSelection` | `supported` | `user_config` | Configured via `--model <model>`. |
| `usageData` | `supported` | `hook` | Emits cost and token usage in stream summary. |
| `hooks` | `supported` | `hook` | Stream lifecycle hooks via `--include-hook-events`. |
| `transcriptExport` | `unsupported` | `terminal_manifest` | Fallback to bounded terminal capture. |

## Consequences

- Direct, safe CLI invocation without requiring shell expansion.
- Full compatibility with user's existing Claude Code login (no credentials injected or captured by AIBridge).
- Conformance tested with deterministic fake CLI harness before executing installed binary.

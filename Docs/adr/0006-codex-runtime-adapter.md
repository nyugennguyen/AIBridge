# ADR 0006: Codex Runtime Adapter Architecture and Discovery Spike

Status: Proposed / Accepted for Milestone 2 implementation
Date: 2026-09-27
Deciders: Core Architecture Team, Advisor & Reviewer

## Context

AIBridge must orchestrate OpenAI Codex alongside OpenCode and Claude Code. To ensure zero fabricated capabilities, this architecture is grounded in empirical verification of installed `codex-cli` (`0.155.1`).

### Empirical Verification Evidence
Inspecting the installed binary `/opt/homebrew/bin/codex` (`codex-cli 0.155.1`):
1. **Version probe**: `codex -V` prints `codex-cli 0.155.1`.
2. **Headless Execution**: `codex exec [OPTIONS] [PROMPT]` runs non-interactively.
3. **Structured Streaming**:
   - `--json`: Emits streaming execution events to stdout as JSON Lines.
   - `-o, --output-last-message <FILE>`: Writes the agent's final message to a specified file path.
   - `--output-schema <FILE>`: Validates final response shape against a JSON schema.
4. **Working Directory & Workspace**:
   - `-C, --cd <DIR>`: Sets execution working root.
   - `--skip-git-repo-check`: Allows running Codex outside a Git repository (only supplied when target directory lacks `.git`).
5. **Session Control & Resumption**:
   - `codex exec resume <SESSION_ID> [PROMPT]`: Resumes a prior session by session ID.
   - `--ephemeral`: Disables disk persistence when test isolation is needed.
6. **Sandboxing & Permissions**:
   - `-s, --sandbox <read-only|workspace-write|danger-full-access>`: Configures execution sandbox boundary.
   - `-a, --ask-for-approval <on-request|never>`: Approval policy.
   - Notice: Codex CLI in non-interactive `exec` mode does not provide interactive structured bidirectional permission callbacks over stdout/stdin without external daemon integration.

## Decision

1. **Execution Model**:
   - AIBridge executes Codex using direct argv: `[codexPath, "exec", "--json", "-C", projectPath, "-s", sandboxMode, ...args]`.
   - Never invokes a subshell.
   - If project directory is not a Git repo, adds `--skip-git-repo-check`.
2. **Session Identification, Restore, & Prompt Delivery**:
   - When launching, Codex outputs session startup event with thread/session ID.
   - The thread/session ID is captured and recorded in `RuntimeSessionReference.adapterMetadata.handle`.
   - `restore` is a verification step that validates session reference scope, workspace directory existence, and recorded handle.
   - Follow-up `prompt()` either pipes prompt text via child process stdin if running, or executes `codex exec resume <handle> [PROMPT]`.
3. **Observation & Normalization**:
   - Consumes stdout as JSON Lines (`--json`):
     - Thread creation / message events map to `working`.
     - Tool execution / file edits map to `working`.
     - Non-interactive approval pauses or permission denials map to `blocked` or `failed`.
     - Task completion events paired with valid output message map to `completed`.
   - If stdout terminates with exit code 0 but without completion payload or message, status degrades to `unknown`.
   - Non-zero exit code maps to `failed`.
4. **Control Boundaries**:
   - `interrupt` sends `SIGINT` to halt current command processing.
   - `terminate` sends `SIGTERM`, waiting up to `DEFAULT_TERMINATION_GRACE_PERIOD_MS` (3000ms) before escalating to `SIGKILL`.
   - `respond()`: Calling `respond()` returns typed error `ContractError` with `category: "unsupported_capability"`, code `"runtime.codex.permissions_unsupported"`.
5. **Capability Declarations**:

| Capability | Status | Evidence Source | Detail / Fallback |
| --- | --- | --- | --- |
| `structuredPermissions` | `unsupported` | `user_config` | Interactive bidirectional permissions not supported in headless `exec` mode. Projected to `false`. |
| `nativeSessionRestore` | `supported` | `process_state` | Resumed via `codex exec resume <handle>`. |
| `reliableCompletion` | `supported` | `hook` | Emits structured JSONL event stream and optional output-last-message. |
| `modelSelection` | `supported` | `user_config` | Configured via `-m, --model <MODEL>`. |
| `usageData` | `supported` | `hook` | Emitted in execution event stream. |
| `hooks` | `unsupported` | `process_state` | Uses stdout JSONL streaming rather than external hooks. |
| `transcriptExport` | `unsupported` | `terminal_manifest` | Fallback to bounded terminal capture. |

## Consequences

- Full alignment with actual CLI capabilities without simulating unsupported bidirectional RPC permissions.
- Explicit `structuredPermissions: false` ensures the orchestration engine handles authorization before launch rather than expecting live interactive permission RPC.
- Conformance verified against the provider-neutral harness.

# ADR 0005: Claude Code Runtime Adapter Architecture and Discovery Spike

Status: Accepted (revised 2026-11-25 for the real stream-json protocol)
Date: 2026-09-27 (revised 2026-11-25)
Deciders: Core Architecture Team, Advisor & Reviewer

## Context

AIBridge requires multi-runtime support for local AI coding agents. Claude Code is a primary target. To avoid brittle reverse-engineering or hypothetical flags, this architecture is grounded in empirical verification of installed Claude Code.

### Empirical Verification Evidence
The original spike inspected `2.1.138 (Claude Code)`. The 2026-11-25 revision checks the protocol against the official CLI documentation and a capture from CLI `2.1.332` on the staging VPS. The live harness `tests/live/claude-cli.live.test.ts` (`bun run test:live`, gated by `AIBR_LIVE_CLAUDE=1`) re-checks it against whatever version is installed.

1. **Version probe**: `claude --version` prints e.g. `2.1.332 (Claude Code)`.
2. **Headless Execution**: `-p, --print` runs non-interactively without TTY prompts.
3. **Structured Streaming**:
   - `--output-format stream-json --verbose`: newline-delimited JSON events on stdout. Every official example pairs stream-json output with `--verbose`.
   - `--input-format stream-json`: newline-delimited user turns on stdin.
   - `--include-hook-events`: hook lifecycle events in the stream (requires stream-json).
4. **Session Control**:
   - `--session-id <uuid>`: deterministic UUID for session correlation.
   - `-r, --resume <uuid>`: resumes an existing session by UUID.
5. **Permissions & isolation** (all decided at launch):
   - `--permission-mode <mode>`: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. Since v2.1.302, `-p` without a mode denies every call that needs approval; AIBridge always passes the mode explicitly.
   - `--allowedTools` / `--disallowedTools`: permission rules such as `Read` or `Bash(git log *)`. A bare tool name in `--disallowedTools` removes the tool from the model's context.
   - `--max-budget-usd <n>`, `--max-turns <n>`.
   - `--setting-sources user,project,local`, `--settings <file|json>`, `--strict-mcp-config`, `--mcp-config <file>`.
   - `--system-prompt` **replaces** the whole default prompt; `--append-system-prompt` appends to it.
6. **There is no permission request/response protocol** in print mode: no `permission_request` event and no `permission_response` stdin message. Interactive approval only exists through `--permission-prompt-tool`, a `PermissionRequest` hook, or the Agent SDK.
7. **Authentication**: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`. In `-p` mode the API key wins when both are set.

## Decision

1. **Non-Invasive Execution Model**:
   - AIBridge executes Claude Code via direct argv spawning without modifying global `~/.claude.json` or local `.claude/` project configurations.
   - Project directory is passed as the child process `cwd` within the allowlisted project boundary.
   - The child environment goes through `sanitizeChildProcessEnv` with the `CLAUDE_PROVIDER_ENV_KEYS` allowlist (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`). Bridge secrets (`AIBRIDGE_*`, other `*TOKEN*`/`*SECRET*` keys) are stripped; `HOME` and `PATH` pass through.
2. **Session Identification & Restore**:
   - AIBridge generates a UUID v4 for each launch and passes `--session-id <uuid>`; `system/init` confirms it.
   - The UUID is stored in `RuntimeSessionReference.adapterMetadata.handle`.
   - `restore` only returns sessions still held by the adapter process. It does **not** resume with `claude -r <uuid>` after a bridge restart: a reference does not carry the launch profile, and resuming without it would widen the session's permissions. Capability: `conditional`.
3. **Launch, Stream Protocol & Completion**:
   - Launch argv (built by `buildClaudeLaunchArgs`):
     `[claudePath, "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-hook-events", "--session-id", uuid, ("--model", model)?, "--permission-mode", mode, ...profileArgs, ("--append-system-prompt", rolePrompt)?]`
   - **Permissions are decided up front by a launch profile** (`ClaudeLaunchProfile`, supplied by the `launchProfile` adapter option), translated into `--permission-mode` (default `dontAsk`), `--allowedTools`, `--disallowedTools`, `--max-budget-usd`, `--max-turns`, `--setting-sources`, `--settings`, `--strict-mcp-config`, `--mcp-config`. `bypassPermissions` is refused (`policy_denied`).
   - The RoleBinder-compiled prompt (plus any profile `appendSystemPrompt`) is passed with `--append-system-prompt`, so Claude Code keeps its default tool and safety instructions.
   - Each user turn is one stdin line:
     `{"type":"user","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null}\n`
   - The adapter consumes stdout as JSON Lines:
     - `system` / `init` → `working`; records the provider `session_id` and model.
     - `system` / `permission_denied` → recorded as a denial (tool name, tool_use_id, redacted input preview) and surfaced as a `working` lifecycle detail.
     - Any other `system` subtype (hook events, `commands_changed`, …) → `working`.
     - `assistant` / `user` messages, including `tool_use` / `tool_result` content blocks → `working`.
     - Unknown top-level types (e.g. `rate_limit_event`) and non-JSON lines are ignored.
     - `result` → `AgentResult`. The outcome is `succeeded` only when `subtype === "success"` and `is_error` is not true. Error subtypes (`error_max_turns`, `error_during_execution`, `error_max_budget_usd`, …) carry `errors[]` and no `result` text; they map to `failed`.
   - `AgentResult` has only an outcome and a summary, so the summary holds the result text (or the error subtype and `errors[]`) plus a one-line footer: `[claude] subtype=… turns=… cost_usd=… duration_ms=… session=… permission_denials=N (tools)`. The structured data (`total_cost_usd`, `usage`, `num_turns`, `duration_ms`, `session_id`, `errors`, `permission_denials`, exit code and signal) is available through `usageFor(sessionId)` and `permissionDenialsFor(sessionId)`.
   - **stdin closes after the result.** The process exits only once stdin is closed, so for single-shot jobs (the default) the adapter ends stdin as soon as every submitted turn has produced a `result`. `keepStdinOpen` keeps it open for multi-turn use; `terminate` always closes it. `prompt()` on a closed stdin fails with `runtime.prompt.closed`.
   - Exit handling: the exit code **and** signal are recorded. stdout is drained before the session is finalised, because `exit` can fire before the final `result` line is read. With a `result`, the result decides the outcome. Without one, exit code 0 degrades to `unknown`; a non-zero code, a signal (code `null`), or a spawn error maps to `failed` with a redacted stderr tail.
   - `observe()` is a snapshot, not a live stream: each call drains buffered events and then yields one lifecycle event for the current state (`working` while running; `completed` / `failed` / `unknown` after exit). Callers poll until a terminal state appears.
   - `respond()` always fails with `unsupported_capability` (`runtime.claude.permissions_unsupported`).
4. **Control Boundaries**:
   - `interrupt` sends `SIGINT` to the child process.
   - `terminate` closes stdin and sends `SIGTERM`, waiting up to `DEFAULT_TERMINATION_GRACE_PERIOD_MS` (3000ms) before sending `SIGKILL`.
5. **Idempotency**:
   - Prompt requests are deduplicated by `commandId`. Re-sending an identical command returns `{ ok: true, value: undefined }`; conflicting prompt payloads return `conflict`.
6. **Capability Declarations**:

| Capability | Status | Evidence Source | Detail / Fallback |
| --- | --- | --- | --- |
| `structuredPermissions` | `unsupported` | `user_config` | No permission request/response protocol in print mode. Permissions are fixed at launch by the profile; refusals are reported via `system/permission_denied` and `result.permission_denials`. |
| `nativeSessionRestore` | `conditional` | `process_state` | In-process sessions only; `claude -r` resume after a bridge restart is not implemented (the launch profile cannot be re-derived from a reference). Projected to `false`. |
| `reliableCompletion` | `supported` | `hook` | Final stream-json `result` event (`subtype` + `is_error`). |
| `modelSelection` | `supported` | `user_config` | Configured via `--model <model>`. |
| `usageData` | `supported` | `hook` | `result` carries `total_cost_usd`, `usage`, `num_turns`, `duration_ms`; exposed via `usageFor()`. |
| `hooks` | `supported` | `hook` | Hook lifecycle events via `--include-hook-events`. |
| `transcriptExport` | `unsupported` | `terminal_manifest` | Fallback to bounded terminal capture. |

## Consequences

- Direct, safe CLI invocation without requiring shell expansion.
- No credentials are injected by AIBridge; the worker environment must carry exactly one of `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (or an existing login for the worker's OS user).
- An agent cannot ask for more permissions mid-run. A task that needs a tool outside its profile fails or finishes with recorded denials; the operator changes the profile and re-dispatches.
- Conformance is tested with a deterministic fake CLI that emits the real event format; the live harness checks the installed CLI's flags and behaviour.

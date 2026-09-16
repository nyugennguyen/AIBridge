# Milestone 1: Single-Node TUI Vertical Slice

## Objective

Deliver one complete local workflow through `aibr tui`: select a project, create a one-task run, inspect the dispatch envelope, approve it, launch OpenCode, observe state, attach to its tmux terminal, interact safely, and review the result. This milestone proves the user experience before adding more providers or distributed coordination.

## Prerequisites

- Milestone 0 is complete and its contracts are frozen.
- Existing `aibr setup`, `start`, `serve`, and `status` commands remain green.
- OpenCode is available through the existing loopback-only SDK/server path.
- tmux remains the only production terminal backend.

## Fixed Implementation Decisions

- Use `@opentui/core` with imperative TypeScript renderables for the first TUI. Its official quickstart supports Bun/TypeScript and explicit renderer cleanup ([OpenTUI quickstart](https://opentui.com/docs/getting-started/quickstart/)). Avoid adding React/Solid state management during the vertical slice.
- Run the TUI as a client of an in-process/local-node application service; UI components do not call stores, tmux, or OpenCode directly.
- Use a reducer/view-model boundary so UI rendering is deterministic and testable without a real terminal.
- Terminal input ownership is exclusive. Secondary viewers are read-only.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M1.1 UX state machine and keymap | M0 | `architect` — `gpt-6-astra high` | Screen/state transitions, focus rules, terminal mode, error states, and accessibility keymap | Tabletop walkthrough covers success, reject, cancel, crash, and resize |
| M1.2 TUI shell and lifecycle | M1.1 | `feature-builder` — `gpt-5.6-terra high` | `aibr tui`, renderer lifecycle, layout, navigation, cleanup, and non-TTY errors | Headless renderer tests; terminal restored on every exit path |
| M1.3 Local orchestration application service | M0, M1.1 | `subsystem-builder` — `gpt-5.6-sol high` | One-task run draft, dispatch proposal, approval, launch, status, and result use cases | Service tests with fake runtime, clock, IDs, and store |
| M1.4 OpenCode runtime bridge | M1.3 | `feature-builder` — `gpt-5.6-terra high` | Existing OpenCode behavior adapted to Milestone 0 runtime contract | Existing OpenCode tests plus adapter-focused lifecycle tests |
| M1.5 tmux terminal backend | M0, M1.1 | `subsystem-builder` — `gpt-5.6-sol high` | Create/attach/snapshot/resize/detach/recover/terminate behind `TerminalBackend` | Fake runner unit tests and opt-in local tmux integration test |
| M1.6 Project, run, and approval screens | M1.2, M1.3 | `feature-builder` — `gpt-5.6-terra high` | Project list, run creation, proposal detail, approve/reject/edit, state badges | View-model snapshots at narrow/wide terminal sizes |
| M1.7 Embedded terminal view | M1.2, M1.5 | `subsystem-builder` — `gpt-5.6-sol high` | Rendered terminal stream, resize, input mode, escape chord, read-only view, takeover | PTY/tmux fixture verifies byte ordering and control isolation |
| M1.8 End-to-end harness | M1.3–M1.7 | `test-engineer` — `gpt-5.6-sol high` | Scripted fake OpenCode/tmux acceptance scenario and optional real-agent smoke test | Entire workflow runs deterministically in CI without real credentials |
| M1.9 UX and safety review | All | `independent-reviewer` — `gpt-6-astra high` | Scope, interaction, cleanup, logging, and approval review | Blockers resolved; manual checklist completed on macOS and Linux |

## Task Details

### M1.1 UX State Machine

Define explicit states rather than deriving behavior from the current screen:

- Project selection
- Run draft
- Dispatch proposal pending approval
- Dispatch rejected or revised
- Starting session
- Agent working, blocked, unknown, completed, or failed
- Terminal attached read-only
- Terminal attached with input ownership
- Result review
- Recoverable and fatal errors

Reserve a clearly displayed chord for leaving terminal input mode. That chord is consumed locally and never forwarded. Destructive controls such as terminate require a separate confirmation from normal prompt input.

### M1.2 TUI Shell

- Add `tui` without changing existing CLI command semantics.
- Reject non-interactive stdout with a concise error.
- Restore cursor, alternate screen, input mode, and signal handlers on normal exit, exception, and interrupt.
- Keep colors semantic but do not rely on color alone for status.
- Define minimum terminal size and render a useful fallback rather than crashing.

### M1.3 Local Application Service

- Start with an in-memory event/projection implementation conforming to Milestone 0 contracts; Milestone 3 replaces storage.
- Bind approval to the dispatch digest.
- Recompute and invalidate approval after any editable field changes.
- Use injected runtime, terminal, clock, ID source, and project registry.
- Keep every UI action as an application command with a typed result.

### M1.5 and M1.7 Terminal Safety

- Build shell commands as argv arrays only.
- Target tmux by validated internal IDs, never user-concatenated shell fragments.
- Normalize resize dimensions and set upper/lower bounds.
- Prevent input when the session is not owned or is in read-only mode.
- Bound snapshot and buffered stream size.
- Make detach preserve the session; terminate is a distinct command.

## Completion Criteria

- `aibr tui` completes the entire approved one-task OpenCode flow locally.
- No dispatch begins before approval, and editing a proposal invalidates approval.
- The TUI can close/reopen without stopping the tmux/OpenCode session.
- The embedded terminal supports resize, safe input mode, read-only viewing, and explicit takeover.
- All renderer shutdown paths restore the user's terminal.
- Unknown/unsupported OpenCode state is visible and never displayed as success.
- Existing CLI, bridge, security, and job tests remain green.
- The deterministic fake-agent end-to-end scenario passes in CI.
- Manual smoke tests pass on supported macOS and Debian/Ubuntu environments.

## Guardrails and Stop Conditions

- Do not add Claude Code, Codex, remote terminal WebSockets, or mesh enrollment.
- Do not let UI components access filesystem, tmux, SDK, or network clients directly.
- Do not retain raw terminal transcripts by default.
- Do not replace tmux or create a general terminal emulator.
- Do not add auto-approval; the only path is explicit user approval.
- Stop if OpenTUI cleanup cannot reliably restore the terminal on supported platforms; resolve lifecycle ownership before adding screens.
- Stop if terminal input can reach the wrong session or survive after ownership loss.

## Gate Verification

```bash
bun test tests/unit/tui
bun test tests/unit/terminal
bun test tests/integration/tui-flow.test.ts
bun run typecheck
bun test
bun run build
git diff --check
```

The gate report includes terminal recordings or screenshots for the core states, the final keymap, and evidence from both supported operating-system families.


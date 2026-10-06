# ADR 0010: Mouse-native TUI client and decoupled daemon

Status: Accepted (in progress)
Date: 2026-10-06
Supersedes: nothing. Amends [ADR 0008](./0008-polyglot-ingress-and-admission.md) §4 only.

## 1. The problem

`aibr` is a private Tailscale bridge for coordinating OpenCode agents. It has a
working ingress router ([ADR 0008](./0008-polyglot-ingress-and-admission.md)), a
durable commit-before-`202` admission queue, and a single-screen TUI at
`src/tui/` that is entirely keyboard-driven.

The product direction is a **mouse-native, multi-pane terminal workspace
manager**: a client that shows every workspace, every agent, and every pending
job at once, embeds live OpenCode sessions, and lets an operator approve or
reject a plan without leaving the keyboard. See
[`Docs/implementation-plans/AIBridge_TUI_and_Daemon_Modernization_Plan.md`](../implementation-plans/AIBridge_TUI_and_Daemon_Modernization_Plan.md).

Three things make that more than a rendering change.

1. **The client must be replaceable.** An operator detaches (`Ctrl+B q`), closes
   their laptop, and comes back. The agent keeps working. That requires the
   presentation layer to hold no authority and the runtime to own every PTY.
2. **Agents need human approval.** A plan review, a sensitive file edit, or a
   destructive command must interrupt and wait for a human — with a diff, a risk
   indicator, and an audit trail.
3. **Terminals are not line-oriented.** Embedding `opencode` means embedding a
   real VT parser: truecolor, cursor addressing, and the alternate screen.

## 2. Decision

Introduce three Rust components alongside the existing TypeScript engine, and a
local IPC bus between them.

```
                    Tailscale (100.64.0.0/10)
                              │
                    ┌─────────▼──────────┐
                    │  aibr-router       │  unchanged: ingress admission
                    │  (Rust, 32 MiB)    │  commit-before-202, WAL
                    └─────────┬──────────┘
                              │ durable row
                    ┌─────────▼──────────┐
                    │  aibr-worker       │  Bun/TS: leases, authorization,
                    │  + IPC server      │  redaction, PTY orchestration
                    └─────────┬──────────┘
                              │ 4-byte length prefix + JSON
                              │ Unix socket / named pipe
            ┌─────────────────┴──────────────────┐
   ┌────────▼─────────┐              ┌───────────▼────────┐
   │ aibr-tui         │              │ aibr setup        │
   │ ratatui+crossterm│              │ onboarding wizard │
   └──────────────────┘              └────────────────────┘
```

### 2.1 Crates

| Crate | Language | Owns |
| --- | --- | --- |
| `router/` | Rust | Ingress admission. **Unchanged by this ADR.** |
| `crates/aibr-ipc` | Rust | Wire contracts (generated), framing, transport |
| `crates/aibr-pty` | Rust | OpenCode child inside a `portable-pty` |
| `crates/aibr-tui` | Rust | Rendering, layout, input. Ephemeral. |

### 2.2 Contracts are generated, not declared twice

The wire shapes are declared **once**, as Zod schemas in `src/ipc/schemas.ts`, and
generated into `crates/aibr-ipc/src/contracts.rs` by the existing ADR 0008 §2.3
chain. The Rust daemon and the TypeScript worker cannot drift, and no Rust file
becomes a second hand-maintained copy of a contract.

`contracts/v1/` is partitioned across generated units by
`IPC_CONTRACT_FILES` in `router/contract-gen/src/main.rs`. The generator **fails**
if a schema is claimed by neither partition or both, and asserts the partitions
share no root type name. Without this the router would compile 227 generated types
for messages it never receives — against a binary already over its original 2 MiB
bound.

### 2.3 Invariants

These are the properties the rest of the system is built to preserve. Each is
load-bearing and each has a test.

1. **Detach is not shutdown.** `ControlCommand::Detach` closes a socket. There is
   deliberately no "detach and stop" command for a convenience to be added to
   later. Acceptance criterion 6.
2. **A diff applies only onto the sequence it names.** A client that is behind
   re-requests a snapshot. Applying a diff onto a gap leaves the client silently
   wrong about which panes exist, and no later frame reveals it.
3. **The PTY outlives the connection.** Dropping an IPC connection does not
   signal the child process.
4. **A client is replaceable.** All authority is in the daemon. `UiState` is
   rebuilt from a `StateSnapshot` on every attach.
5. **Redaction is a pipeline, not a filter.** Nothing agent-authored is
   published, rendered, or copied to the clipboard without passing through
   `src/observability/redaction.ts`. Acceptance criteria 7 and 8.

## 3. Consequences

### 3.1 What this costs

- **A second language in more places.** ADR 0008 §4 permitted Rust in `router/`
  only. This ADR extends that to `crates/`. The guardrail is **not** loosened:
  Rust remains confined to `router/` and `crates/`; `src/` stays TypeScript; and
  neither acquires a dependency on the other. The TUI reaches the engine over the
  socket precisely so no import edge exists in either direction.
- **The workspace root moved.** Cargo refuses a member that is not below its
  workspace root, and `crates/aibr-tui` is a sibling of `router/`, so the root
  moved from `router/Cargo.toml` to `./Cargo.toml`. `[profile.release]` moved
  with it — Cargo honours profiles only at the root — **copied verbatim**, because
  the musl binary-size gate in `.github/workflows/milestone-7.yml` is calibrated
  on exactly those flags. Any edit to that table must re-measure before the 2.25
  MiB bound is trusted again.
- **The generated contracts are duplicated per union arm.** `StateSnapshot` and
  `ServerMessage::StateSnapshot` are different Rust types with the same wire
  shape, because typify expands union arms in place and the committed JSON Schema
  is a Zod `z.discriminatedUnion` whose arms are full objects. This is why
  `crates/aibr-tui/src/state/` declares its own `Job`/`Pane`/`Workspace` types and
  converts at the boundary: storing generated types would mean converting between
  two hierarchies at every apply, where a dropped field becomes a client that
  never sees a `blocked` transition and so never opens the approval modal.
  Rewriting the generator to emit a `$ref` graph would mean a post-pass inventing
  structure Zod did not declare — the divergence ADR 0008 §2.3 exists to prevent.

### 3.2 Deviations from the plan, and why

The plan is the product direction. Three of its technical specifics were changed,
and the reason is recorded here rather than left to be rediscovered.

| Plan says | This ADR does | Why |
| --- | --- | --- |
| IPC socket at `/var/run/aibr/daemon.sock` | User-scoped: `$XDG_RUNTIME_DIR/aibr/daemon.sock`, else `/tmp/aibr/aibrd.sock`; parent created `0700` | A path under `/var/run` needs root to create, and a socket in a world-writable directory lets **any local user** reach a daemon that runs OpenCode inside the owner's project allowlist. Windows keeps the plan's named pipe: a pipe inherits the process token's ACL, where a loopback port is reachable by anything that guesses it. |
| `ServerMessage` as `Framed JSON-RPC` / union | Discriminated on `type` | An untagged union makes serde try each arm in declaration order and take the first that parses. `PtyChunk` and `PtyExit` are both keyed by `paneId`, so the winner would depend on JSON field **order**. A frame would decode into the wrong type and nothing would report it. |
| 60fps mouse drag, `Ratatui 0.30` | Same | No deviation; noted because the version pins are enforced by `Cargo.lock`. |

### 3.3 Not decided here

- **`ghostty-vt` vs `vte`.** This ADR uses `vte` (byte-level parser, no screen).
  The grid, scrollback, and alternate-screen handling are written in
  `crates/aibr-tui/src/vt/`, which is also what makes them unit-testable without a
  terminal. Swapping in `ghostty-vt` later is a contained change **iff** the grid
  stays behind a trait.
- **Phase 1's `aibr setup` wizard.** Out of scope for this ADR. It writes config,
  which is the ingress boundary's concern, and the router's config module is not
  being moved.

## 4. Verification

| Criterion | Where it is proved |
| --- | --- |
| `cargo check` / `cargo test` clean, no warnings | CI; `clippy -D warnings` across the workspace |
| Contracts reproducible | CI runs `bun run generate:contracts` then `git diff --exit-code` |
| TypeScript ↔ Rust contract drift | `crates/aibr-ipc/tests/frame_cap_parity.rs` reads `src/ipc/schemas.ts` and asserts the hand-written constants agree |
| Unknown frame tags are refused, not skipped | `aibr_ipc::DecodeError::UnknownTag`; a client that skipped messages would silently drop a `blocked` transition |
| Detach leaves work running | PTY host tests assert the child is alive after the socket closes |
| Redaction on streamed logs and clipboard | `tests/security/redaction-audit.test.ts` (TS) + the client-side grid filter's canary test (Rust) |

## 5. References

- [ADR 0008](./0008-polyglot-ingress-and-admission.md) — ingress admission, the
  contract chain, and the polyglot guardrail amended here.
- [`Docs/implementation-plans/README.md`](../implementation-plans/README.md) —
  global guardrails and the sub-agent execution protocol.
- [`Docs/implementation-plans/AIBridge_TUI_and_Daemon_Modernization_Plan.md`](../implementation-plans/AIBridge_TUI_and_Daemon_Modernization_Plan.md) —
  the product direction this implements.
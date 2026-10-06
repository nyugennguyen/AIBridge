# TUI and daemon modernization — completion report

Implements Phases 2 through 6 of
[`AIBridge_TUI_and_Daemon_Modernization_Plan.md`](../implementation-plans/AIBridge_TUI_and_Daemon_Modernization_Plan.md).
The architecture and the three deliberate deviations from the plan are recorded in
[ADR 0010](../adr/0010-tui-daemon-modernization.md); this report records what was
built, what was verified, and what was not.

## Scope delivered

| Component | Crate / path | Language |
| --- | --- | --- |
| Ingress admission router (unchanged) | `router/` | Rust |
| Wire contracts, framing, listener | `crates/aibr-ipc/` | Rust |
| OpenCode PTY host | `crates/aibr-pty/` | Rust |
| Workspace client | `crates/aibr-tui/` | Rust |
| Daemon-side listener bridge | `src/ipc/publisher.ts`, `src/ipc/bridge.ts` | TypeScript |
| Ingress lifecycle observer | `src/ingress/drainer.ts` | TypeScript |

**Not delivered.** Phase 1's `aibr setup` wizard is out of scope: it writes
configuration, which is the ingress boundary's concern, and this effort does not move
the router's config module. `aibr tui` falls back to the existing OpenTUI shell when
the Rust binary has not been built, so the command works either way.

## Contracts

Declared once, as Zod in `src/ipc/schemas.ts`, generated to both Rust units by the
ADR 0008 §2.3 chain:

```
Zod  ->  contracts/v1/*.schema.json  ->  typify  ->  router/src/contracts.rs
                                                 \-> crates/aibr-ipc/src/contracts.rs
```

`aibr-contract-gen` partitions `contracts/v1/` by an explicit file list and **fails
generation** if a schema is claimed by neither partition or both, and if the two
partitions share a root type name. Without the partition the router would compile
227 generated types for messages it never receives, against a binary already over its
original 2 MiB bound.

## Verified against a running client

Driven with real SGR 1006 mouse events against a live socket, at 120x40, with the
byte stream replayed into a character grid:

| Criterion | Result |
| --- | --- |
| 1. `cargo check` / `cargo test` clean, no warnings | 356 tests; `clippy -D warnings` clean across the workspace |
| 2. `aibr tui` connects over IPC and reflects live `ingress_outbox` | Header outbox count moved 5 → 9 from a `state_diff` while the client ran |
| 3. Terminal renders ANSI with correct proportions | Truecolor reached the buffer unquantised; a wide glyph occupied two columns with the second blank |
| 4. A blocked job opens the approval modal | Modal rendered centred with clickable buttons for a job already blocked at attach |
| 5. Mouse drag on a split border resizes panes | A 20-column drag moved the seam exactly 20 columns; `resize_pane` reported left=68, right=27, which is exactly what the rendered row shows |
| 6. Detach leaves work running; re-running restores | `Ctrl+B q` exited 0, left the alternate screen, released mouse capture, and sent `detach`; a second client re-attached and hydrated from the same daemon |
| 7. Streamed logs and clipboard copies scrubbed | 12 canary tests; each asserts on the canary string, not on "the output changed" |

## Defects found and fixed during verification

Each was found by driving the real client, not by reading the code. They are listed
because the pattern matters more than the instances: **every one of them produced a
client that looked alive and was not.**

1. **The frame drain blocked.** `next_frame().await` in the render loop waited for a
   frame a quiet daemon never sends, so the loop never drew. An idle session showed a
   frozen blank screen — the worst failure this TUI can have, because it is
   indistinguishable from a hang.
2. **PTY output never reached its pane.** `apply_frame` handled snapshots and diffs
   and returned `true` for everything else.
3. **The modal never opened for an already-blocked job.** `attach` consumes the
   snapshot frame, so nothing ever triggered `refresh_modal`. An operator re-attaching
   to a session that blocked while they were away saw nothing.
4. **Input actions were discarded.** The engine is pure and returns `Vec<Action>`;
   nothing sent them, so resizes never reached the daemon.
5. **Every border drag reported no resize.** The live preview applies the ratio as the
   mouse moves, so by mouse-up the `moved == 0` guard fired on every drag.

Plus three in the VT engine and two in the layout, all found by tests: scroll_up
shifted content the wrong way and then in the wrong order; a half-assembled grapheme
cluster survived any grid mutation; nested splits dropped their inner seams while
seam and children were computed independently.

## Deliberate deviations from the plan

Recorded with reasoning in ADR 0010 §3.2. In short: the IPC socket is user-scoped
rather than `/var/run/aibr`, because a socket in a world-writable directory lets any
local user reach a daemon running inside the owner's project allowlist;
`ServerMessage` is discriminated on `type`, because an untagged union lets serde pick
the first arm that parses and `PtyChunk`/`PtyExit` are both keyed by `paneId`; and
the TUI keeps its own `Job`/`Pane` types, because the generated contracts exist in two
type hierarchies and storing the generated ones would mean converting between them at
every apply, where a dropped field becomes a client that never sees a `blocked`
transition.

## Known limitations

Each is a real gap, not a deferred nicety.

- **`View Outbox Item` cannot work.** The contract has no such command and no snapshot
  field carries the payload. The menu item emits an explaining toast rather than
  silently doing nothing.
- **The PTY host is not wired to the bus.** `aibr-pty` emits `PtyChunk`/`PtyExit`
  through a `PtySink` trait; nothing implements it by forwarding to the listener, so
  pane commands from a real client are answered `not_allowed`. The Rust types and the
  `PaneController` interface are the seam; filling it is wiring, not design.
- **`approve_plan` / `reject_plan` are answered `accepted: false`.** They need the
  engine's plan-review path, which sits behind the job manager. Answering `false` is
  deliberate: silence would leave a client waiting on a modal forever.
- **The Rust listener and the TypeScript publisher are two implementations of one
  listener.** They agree by construction — same path constants, same frame codec — and
  a parity test asserts the path resolution matches the Zod declarations, but no test
  runs a TUI against both.
- **The client's redactor is deliberately conservative, not production.** The
  TypeScript pipeline is authoritative; this is a second pass on the way out. A test
  asserts the engine's `[REDACTED_SECRET]` marker does *not* appear from the client, so
  swapping in the real redactor fails loudly.
- **`Split` from the input engine is a shell-level request.** `spawn_pane` needs a
  command and a working directory, and neither is something a click can say, so the
  variant is dropped rather than invented.
- **Negative row addressing (`CSI -1;1H`) is not parsed by `vte`.** A bottom-anchored
  status bar must use a large positive row. Recorded in the VT module header.
- **Scrolling regions are accepted and ignored.** Full-screen programs set one and
  then redraw every row inside it.

## Verification commands

```bash
bun run typecheck                 # clean
bun test                          # 5360 pass, 0 fail, 4 skip
bun run generate:contracts        # no diff: both generated units reproduce byte-identically
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace            # 356 pass, 0 fail
```

## Prerequisites for the next milestone

- `crates/aibr-pty` needs a `PtySink` implementation forwarding to the listener's peer
  handle, and a `PaneController` on the TypeScript side backed by it.
- The client's redactor should be replaced by one over the shared rules, which the
  `Redactor` trait exists to make a one-field swap.
- `View Outbox Item` needs either a contract command or a decision to remove it.
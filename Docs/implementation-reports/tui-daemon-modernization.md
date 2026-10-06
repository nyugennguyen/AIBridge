# TUI and daemon modernization — implementation report

Implements Phases 2 through 6 of
[`AIBridge_TUI_and_Daemon_Modernization_Plan.md`](../implementation-plans/AIBridge_TUI_and_Daemon_Modernization_Plan.md).

Branch: `aibr-v2`. Base: `origin/aibr-v2`. Thirteen commits, 101 files,
+40289 / −888 lines. Not merged to `main`.

Architecture and the three deliberate deviations from the plan are in
[ADR 0010](../adr/0010-tui-daemon-modernization.md). This report records what was
built, what was verified and by what means, and what is not finished.

---

## 1. Scope

### Delivered

| Component | Path | Language | Hand-written LOC |
| --- | --- | --- | --- |
| Ingress admission router (**unchanged**) | `router/` | Rust | — |
| Wire contracts, framing, listener | `crates/aibr-ipc/` | Rust | 1 762 src + 820 tests |
| OpenCode PTY host | `crates/aibr-pty/` | Rust | 898 src + 421 tests |
| Workspace client | `crates/aibr-tui/` | Rust | 10 931 src + 5 714 tests |
| Daemon-side listener bridge | `src/ipc/publisher.ts` (847), `src/ipc/bridge.ts` (410) | TypeScript | 1 257 |
| Ingress lifecycle observer | `src/ingress/drainer.ts` | TypeScript | — |
| CLI routing to the Rust client | `src/tui/rust-client.ts`, `src/cli.ts` | TypeScript | — |

Excluded from those LOC figures: `contracts.rs` (9 806 generated lines in
`aibr-ipc`, 83 472 in the router). They are build outputs committed on purpose —
ADR 0008 §2.3 explains why.

### Not delivered

**Phase 1's `aibr setup` wizard.** It writes configuration, which is the ingress
boundary's concern, and this effort does not move the router's config module. It is
therefore neither implemented nor stubbed.

**The PTY host is not wired to the bus.** `crates/aibr-pty` is complete and tested
against real processes, but nothing implements its `PtySink` trait by forwarding to
the listener's peer handle. Pane commands arriving from a client are answered
`not_allowed`. See §8.

**`approve_plan` / `reject_plan` return `accepted: false`.** They need the engine's
plan-review path, which sits behind the job manager. Answering `false` is
deliberate — silence would leave a client sitting on a modal forever.

---

## 2. Architecture as built

```
                      Tailscale (100.64.0.0/10)
                                │
                      ┌─────────▼─────────┐
                      │  aibr-router      │  unchanged: commit-before-202 admission
                      │  (Rust, 32 MiB)   │  WAL, crash-tested, unchanged
                      └─────────┬─────────┘
                                │ durable row
                      ┌─────────▼─────────┐
                      │  aibr-worker      │  Bun/TS: leases, authorization,
                      │  + IPC publisher  │  redaction, ingress_outbox drain
                      └─────────┬─────────┘
                                │ 4-byte BE length prefix + UTF-8 JSON
                                │ Unix socket / named pipe, 8 MiB cap
              ┌─────────────────┴──────────────────┐
     ┌────────▼─────────┐              ┌───────────▼────────┐
     │ aibr-tui         │              │ aibr setup        │
     │ ratatui+crossterm│              │ onboarding wizard │  NOT DELIVERED
     │ ephemeral        │              └────────────────────┘
     └──────────────────┘
                    │
              ┌─────▼─────┐
              │ aibr-pty  │  opencode inside portable-pty
              └───────────┘  outlives its client
```

The TUI reaches the engine **only** over the socket. Neither side imports the
other, which is what keeps ADR 0008 §4's polyglot guardrail intact while still
allowing Rust in `crates/`.

### Module ownership

```
crates/aibr-tui/src/
  state/app.rs        UiState, pure reducers, no I/O
  daemon/mod.rs       IPC client: connect, hydrate, stream, detach
  layout/             TileLayout (BSP), chrome partitioning, HitTest
  vt/                 headless VT parser, grid, scrollback, sequence tracking
  input/              keyboard state machine, mouse routing, clipboard, redaction
  widgets/            terminal pane, diff view, approval modal, render pass
  session.rs          the terminal: enter, loop, restore
```

---

## 3. Commit history

| Commit | What it established |
| --- | --- |
| `45b9256` | IPC v1 contracts in Zod, contract partitioning, workspace root moved to the repo root |
| `e9b50d5` | Ignore `.worktrees/` and the root `target/` |
| `06cc02b` | Stop tracking 598 committed build artefacts |
| `4f1c92e` | Frame codec, tag dispatch, the daemon IPC client |
| `d965826` | ADR 0010; CI, build matrix and the debugging skill repointed at the new workspace root |
| `64dd2f7` | BSP layout engine with exact tiling and shared hit-test geometry |
| `5fdb89b` | Headless VT emulator: truecolor, alternate screen, scrollback |
| `c5df9d9` | IPC listener, PTY host, and the input engine (integrated from three workstreams) |
| `3bd3b75` | Render pass, widgets, terminal session loop |
| `8f494dd` | The client actually renders; the modal opens at startup |
| `e331a14` | `aibr tui` routes to the Rust client; redaction canaries |
| `a335058` | Input actions reach the daemon; border drags report a resize |
| `d6e428b` | This report |

### A note on how this was built

The plan called for four parallel workstreams in isolated worktrees. Three of the
four sub-agents died mid-task on an infrastructure error (a decode failure on the
model gateway), leaving clean worktrees and nothing recoverable. The fourth
completed and its work — 14 modules, 80 tests — was integrated.

The remaining three workstreams were then written directly. That is worth
recording not as an excuse but because it changed the outcome: **five defects
survived code review, unit tests, and `clippy`, and were found only by running the
real client.** See §7.

---

## 4. Contracts

Declared once, as Zod in `src/ipc/schemas.ts`, generated into two Rust units by
the existing ADR 0008 §2.3 chain:

```
Zod  →  contracts/v1/*.schema.json  →  typify  →  router/src/contracts.rs
                                               \→ crates/aibr-ipc/src/contracts.rs
```

`aibr-contract-gen` partitions `contracts/v1/` by an explicit file list and
**fails generation** when a schema is claimed by neither partition or both, and
when the two partitions share a root type name. Without the partition the router
would compile 227 generated types for messages it never receives, against a binary
already over its original 2 MiB bound.

**Framing.** 4-byte big-endian length, UTF-8 JSON, `8 * 1024 * 1024` byte cap. The
cap is checked against the *announced* length before anything is allocated: the
announcement comes from the peer, so a reader that sized a buffer on trust would
let four bytes request eight megabytes.

**Tag discrimination.** `ServerMessage` is discriminated on `type`, and the tag is
peeled before decoding so an unrecognised frame reports an unknown protocol
version rather than a malformed payload — the two mean different operator actions.

---

## 5. Design decisions

### One geometry computation, many readers

`TileLayout::compute` produces every rectangle; the render pass draws them and
`HitTest` resolves clicks against them. There is no second function that computes
where a pane is, and there must never be one.

This is not tidiness. Acceptance criterion 5 requires border dragging to resize
without tearing, and the way that breaks is a hit-test that knows about
`split_ratio` while the renderer knows about rounded pixel rects: the two agree
until they disagree, and then every click lands one cell off what the operator
sees. The cure is structural — one computation — not a careful one.

The sidebar's row rectangles come back *out of* the draw function and go to the
hit-test, for the same reason: a row's height is not derivable from geometry alone
because the sidebar is a list of variable-height sections.

### Integer arithmetic at the leaves, ratios only in the tree

Ratios live in the tree; integers live at the leaves. `compute` walks once,
deducts the seam cell, then divides what remains, with the second child computed
by subtraction. Dividing first and deducting afterwards loses a cell to rounding
somewhere, and the children stop exactly tiling their parent — which is what makes
borders drift apart under repeated splits.

Verified per-cell, per-row, across 35 terminal sizes including odd widths.

### `MIN_PANE_CELLS` as both a ratio floor and a width floor

A ratio floor alone does not prevent a collapsed pane: at a ratio of 0.02 in a
40-column canvas the child rounds to zero columns, and a zero-width pane cannot be
clicked, scrolled, or dragged back. The operator would have to detach and re-attach
to recover.

### The alternate screen is a second grid, not a flag

`opencode` and most full-screen programs use `?1049h`. As a boolean flag on one
grid, switching destroys the primary and switching back shows a blank pane. Both
grids are retained, so a pane that attached mid-session can show either.

### 24-bit colour, never quantised

`Color::Rgb` maps straight to `ratatui::Color::Rgb`. `opencode` emits truecolor and
that is the point of embedding a VT. Indexed and named colours are kept as
distinct variants and resolved at render time, because the first sixteen ANSI
colours are theme-dependent and resolving them in the emulator would bake one theme
into a stream that would then need re-feeding to change.

### The cursor may sit at `column == width`

After writing the last cell the cursor is left one past the grid. That is the
**pending wrap** state a real terminal uses: the cursor stays visually on the last
column and wraps when the next character arrives. Clamping instead would make the
next character overwrite the one just written.

### Selection is anchored in pane-content coordinates

Not screen coordinates. A screen-local selection silently moves to different text
when a divider is dragged — the same class of bug as a hit-test with its own
geometry.

### Redaction on every path out, enforced by the type

`RedactedText`'s constructor is crate-private, so a caller outside the crate
cannot put an unredacted string on the clipboard even by accident. Redaction runs
on drag-select, `y` yank, and raw-log copy, because the client cannot know what is
in a pane.

### The socket parent directory is created `0700`

A socket in a world-writable directory lets **any local user** reach a daemon that
runs OpenCode inside the owner's project allowlist. The directory mode is the
security property; the bind succeeding is not.

### Per-peer queue bounded in frames *and* bytes

`MAX_OUTBOUND_BYTES = 4 MiB`. A frame count alone is 64 MiB per peer at 256 KiB
chunks and 2 GiB across the connection limit. A lossless frame (snapshot, diff,
`pty_exit`, ack, error) is never evicted to make room — the peer is closed instead,
because its state is already wrong and re-attaching re-hydrates.

### Terminal restoration is a panic hook, not a `Drop` impl

The release profile sets `panic = "abort"`, which means there is no unwind and a
`Drop` would never run. An operator left with a shell that does not echo and does
not wrap cannot see the cause. The hook is the path that actually executes; the
guard is also restored explicitly on ordinary return.

### The terminal is entered only after the first snapshot

Entering first would mean the operator watches a blank alternate screen for the
ten seconds a cold daemon may need to spawn its PTYs, with no way to tell working
from wedged.

### `Ctrl+Alt` chords are stolen unconditionally from the focused pane

Considered and rejected: forwarding them when the pane has no scrollback, or
requiring a double press. Both make behaviour depend on invisible state, and an
operator who cannot tell why a chord sometimes switches panes will work around the
client. `ChordPolicy::ForwardToPane` exists for the operator who needs `Ctrl+Alt`
inside an application.

### Prefix timeout is 2000 ms, not tmux's 1000 ms

This client is used over SSH, where one delayed packet loses the second key of a
two-key sequence. The timeout bounds the cost: a longer window in which a mistyped
`Ctrl+B` eats the next key.

---

## 6. Verification

### Gates

```
$ cargo fmt --all --check
(clean)

$ cargo clippy --workspace --all-targets -- -D warnings
0 errors, 0 warnings

$ cargo test --workspace
367 passed; 0 failed
   aibr-ipc     33   (10 lib, 3 cap-parity, 9 codec, 11 listener)
   aibr-pty     19   (8 lib, 11 host)
   aibr-router 137   (unchanged by this work)
   aibr-tui    178   (80 input, 27 layout, 34 vt, 14 render, 12 redaction, 11 modal)

$ bun run typecheck
(clean)

$ bun test
5360 pass, 0 fail, 4 skip, 94350 expect() calls, 251 files

$ bun run generate:contracts
no diff: both generated units reproduce byte-identically
```

The four skips are pre-existing: SQLite outbox tests that need a node driver
unavailable in this runtime.

### End-to-end

Driven by forking the real release binary under a pseudo-terminal at 120×40, with
the byte stream replayed into a character grid and inspected cell by cell.

| Criterion | Result |
| --- | --- |
| 1. `cargo check` / `cargo test` clean, no warnings | 367 tests; `clippy -D warnings` clean across the workspace |
| 2. Client connects over IPC and reflects live `ingress_outbox` | Header outbox count moved **5 → 9** from a `state_diff` while the client ran |
| 3. Terminal renders ANSI with correct proportions | Truecolor reached the buffer unquantised; a wide glyph occupied two columns with the second blank |
| 4. A blocked job opens the approval modal | Modal rendered centred with clickable buttons, for a job **already blocked at attach** |
| 5. Mouse drag on a split border resizes panes | A 20-column drag moved the seam exactly 20 columns; `resize_pane` reported `left=68, right=27` — precisely what the rendered row shows |
| 6. Detach leaves work running; re-running restores | `Ctrl+B q` exited 0, left the alternate screen, released mouse capture, sent `detach`; a second client re-attached and hydrated from the same daemon |
| 7. Streamed logs and clipboard copies scrubbed | 12 canary tests, each asserting on the canary string specifically |

Criterion 6 is additionally proved at the PTY layer by
`a_dropped_host_and_connection_leave_the_child_running` and
`a_detaching_peer_leaves_the_child_running`, which spawn a real `/bin/sh` in a
real `portable-pty` and assert the child is still alive after the host and the
connection are dropped.

### Driving it yourself

```bash
# 1. Build the client.
cargo build --release -p aibr-tui

# 2. No daemon: expect a clear message and exit 1. The cheapest check there is.
./target/release/aibr-tui            # -> "could not reach the AIBridge daemon..."

# 3. A daemon that serves real-looking state, with no engine configured.
node scripts/fake-ipc-daemon.mjs &

# 4. Attach.
AIBRIDGE_IPC_SOCKET=/tmp/aibr-tui-dev/aibrd.sock ./target/release/aibr-tui
```

`aibr tui` routes to the same binary when it is built, falling back to the older
OpenTUI shell otherwise.

### What the end-to-end run actually exercised, and what it did not

**Exercised:** the client binary, the IPC client, frame decode, snapshot
hydration, diff application, PTY chunk delivery, the VT emulator, the layout
engine, the input engine, the render pass, the approval modal, detach, re-attach,
and terminal restoration — against a live socket, with real SGR mouse events.

**Not exercised:** a real `opencode` process inside the PTY, through the listener,
into the client. The daemon used for the end-to-end run was a purpose-built
script speaking the wire protocol, not `aibr worker`. `aibr-pty` is tested against
real child processes, but the seam between it and the listener is unwired (§1), so
no test has yet run OpenCode end to end.

**That is the single largest gap in this report's evidence**, and it is a wiring
gap rather than a design one: the Rust types and the `PaneController` interface
are both in place.

### Redaction canaries

Twelve tests. Each asserts on the canary string itself rather than that "the output
changed", because a test that only checks for a difference passes against a
redactor that mangles everything. One test asserts plain agent output passes
through untouched, because over-redaction is its own failure. The diff pane is
covered separately — it is the densest place agent-authored text appears — and a
destructive command is flagged **by rule name**, so an operator who sees a marker
can dismiss a false positive without re-deriving the judgement.

---

## 7. Defects found

Every client-level defect below produced a client that **looked alive and was
not**. None was visible to code review, to 356 unit tests, or to `clippy`. All
were found by running the real binary against a live socket. That is the argument
for the end-to-end check, and it is the part of this report worth keeping.

| # | Defect | Symptom |
| --- | --- | --- |
| 1 | The frame drain used a blocking `next_frame().await` in the render loop | A quiet daemon sends nothing while an agent thinks, so the loop waited for a frame that never came and never drew. An idle session showed a frozen blank screen — indistinguishable from a hang |
| 2 | `apply_frame` returned `true` for every frame that was not a snapshot or diff | Agent output never reached its pane |
| 3 | The modal never opened for a job already blocked at attach | `attach` consumes the snapshot frame, so nothing triggered `refresh_modal`. An operator returning to a session that blocked in their absence saw nothing, and the agent waited forever for a decision nobody was asked for |
| 4 | `handle_event` discarded the input engine's `Vec<Action>` | The engine is a pure reducer with no channel, so nothing it produced ever reached the daemon: an operator could resize a seam and the agent was never told |
| 5 | `end_border_drag` guarded on `moved == 0` | The live preview applies the ratio as the mouse moves, so by mouse-up the drawn rects already had the new sizes and the guard fired on **every** drag. The seam moved on screen and the daemon heard nothing |
| 6 | `scroll_up` copied content the wrong way, then the right way in the wrong order | Iterating descending reads a row after it has been overwritten, so every row ended up holding the same line and the grid appeared frozen |
| 7 | A half-assembled grapheme cluster survived any grid mutation | An erase left the last character of the previous word behind; a saved cursor restored to a cell that then received a pre-save character |
| 8 | Combining marks attached to the previous cell unconditionally | A *blank* cell also has a grapheme (a space), so every character merged into it |
| 9 | Nested splits dropped their inner seams | Collecting each child's panes into a temporary map and merging lost the seams the child created, leaving a one-cell dark gap |
| 10 | `seam_rect` and `split_children` computed the seam independently | The seam rendered inside a pane; they disagreed by a cell |
| 11 | The modal was **undismissable**. `Action::ModalClosed` was emitted on `Esc` and nothing consumed it; approving, rejecting and aborting all left it on screen; `handle_click` fell through to a default that swallowed everything; and `rect()` answered a hardcoded `80×24` that was not where the modal drew | An operator looking at a blocked job had no way to decide **and** no way to back out. Found while bringing up the test daemon, not by any test — hence `tests/modal_behaviour.rs` |

Defect 11 is the one that most argues for running the thing: it survived 356
passing tests, `clippy -D warnings`, and a full manual read of the modal code,
because nothing in the suite asked what happens *after* a decision.

Three of these were also genuine design errors rather than slips, and are recorded
as such in the code:

- **The `vte::ansi::Processor` coordinate base.** It hands over **zero-based**
  coordinates (it does `y - 1` at the dispatch site). Subtracting again put every
  cursor-addressed character one row and one column above where the program asked —
  which reads as a pane rendering bug, not an emulator bug.
- **`#[rustfmt::skip]` on the generated contracts module.** Without it
  `cargo fmt --all` and `bun run generate:contracts` rewrite the same file
  differently and CI's `git diff --exit-code` fails on a file nobody edited. The
  router had already measured and recorded the alternatives.
- **`scroll_up`'s loop order** (defect 6) is now stated as a comment on the loop,
  because the correct order is the opposite of the intuitive one.

---

## 8. Deviations from the plan

Recorded with reasoning in ADR 0010 §3.2. In brief:

| Plan says | This does | Why |
| --- | --- | --- |
| IPC socket at `/var/run/aibr/daemon.sock` | User-scoped: `$XDG_RUNTIME_DIR/aibr/daemon.sock`, else `/tmp/aibr/aibrd.sock`; parent created `0700` | A path under `/var/run` needs root, and a socket in a world-writable directory lets any local user reach a daemon running inside the owner's project allowlist. Windows keeps the plan's named pipe: a pipe inherits the process token's ACL, where a loopback port is reachable by anything that guesses it |
| `ServerMessage` as an untagged union | Discriminated on `type` | An untagged union makes serde try each arm in declaration order and take the first that parses. `PtyChunk` and `PtyExit` are both keyed by `paneId`, so the winner would depend on JSON field **order** — a frame would decode into the wrong type and nothing would report it |
| Cargo workspace at `router/` | Moved to the repository root | Cargo refuses a member that is not below its workspace root, and `crates/aibr-tui` is a sibling of `router/`. `[profile.release]` moved **verbatim**, because the musl size gate is calibrated on exactly those flags |

One consequence worth flagging: the workspace move changed the build output path
from `router/target/` to `./target/`. CI, the musl build matrix, and the
`debugging-aibr-v2` skill were all repointed, and the build matrix now passes
`-p aibr-router` so the 2.25 MiB size bound still measures the same binary it was
calibrated on.

---

## 9. Known limitations

Each is a real gap, not a deferred nicety.

- **The PTY host is not wired to the bus.** `PtySink` has no implementation
  forwarding to the listener's peer handle, so pane commands from a real client
  are answered `not_allowed`. The types and the `PaneController` interface are the
  seam; filling it is wiring.
- **No real `opencode` has been run end to end.** See §6. Every other layer is
  verified against a live socket; this one is not.
- **`View Outbox Item` cannot work.** The contract has no such command and no
  snapshot field carries the payload. The menu item emits an explaining toast
  rather than silently doing nothing.
- **The Rust listener and the TypeScript publisher are two implementations of one
  listener.** They agree by construction — same path constants, same frame codec —
  and a parity test asserts the path resolution matches the Zod declarations, but
  no test runs a TUI against both.
- **The client's redactor is deliberately conservative, not production.** It
  over-redacts on purpose; the TypeScript pipeline is authoritative and this is a
  defence-in-depth second pass. A test asserts the engine's `[REDACTED_SECRET]`
  marker does *not* appear from the client, so swapping in the real redactor fails
  loudly rather than silently changing what an operator sees.
- **`Split` from the input engine is a shell-level request.** `spawn_pane` needs a
  command and a working directory, and neither is something a click can say, so
  the variant is dropped rather than invented.
- **Negative row addressing (`CSI -1;1H`) is not parsed by `vte`.** A
  bottom-anchored status bar must use a large positive row, which is handled
  correctly. Recorded in the VT module header because the cause is not obvious
  from the pane.
- **Scrolling regions (`CSI r`) are accepted and ignored.** Full-screen programs
  set one and then redraw every row inside it.
- **`Split` borders identify a seam by axis, not by node.** `HitTarget::Border`
  names the two panes, but `TileLayout::set_ratio` resolves by axis, so a border
  separating two *subtrees* resolves to the first split on that axis. Unambiguous
  for the top-level seams the current arrangement produces; it would need a node
  id if nested seams become individually draggable.
- **The modal swallows all input while open**, including `Ctrl+B q`. Correct — a
  blocked job must not be dismissible by a stray click meant for the terminal
  behind it — but it means detaching requires `Esc` first. `Esc`, approving,
  rejecting and aborting all close it; that was not true until a defect found
  during test-harness bring-up was fixed (§7, defect 11).

---

## 10. Next steps

Ordered by what unblocks the most.

1. **Implement `PtySink` over the listener's peer handle**, and a `PaneController`
   on the TypeScript side backed by it. This is what turns the client from
   "verified against a protocol" into "verified against OpenCode".
2. **Wire `approve_plan` / `reject_plan` to the engine's plan-review path**, so
   the modal stops answering `accepted: false`.
3. **Replace the conservative redactor** with one over the shared rules. The
   `Redactor` trait exists to make this a one-field swap.
4. **Decide `View Outbox Item`**: add a contract command, or remove the menu entry.
5. **Run one real session end to end** — `aibr worker --ipc-publish`, an actual
   `opencode` session, a real plan review approved through the modal. That is the
   verification §6 could not perform.

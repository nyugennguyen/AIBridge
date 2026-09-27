# Milestone 1 gate evidence

Evidence period: 2026-09-18 through 2026-09-20. This document records executed checks and distinguishes demonstrated behavior from product-owner scope decisions.

## Automated gate

The final integrated candidate passed the exact plan commands:

```text
bun test tests/unit/tui                         31 passed, 0 failed
bun test tests/unit/terminal                    14 passed, 0 failed
bun test tests/integration/tui-flow.test.ts      5 passed, 1 opt-in skip, 0 failed
bun run typecheck                               passed
bun test                                        577 passed, 2 opt-in skips, 0 failed
bun run build                                   passed
git diff --check                                passed
```

The full suite executed 579 tests in 47 files with 1,545 assertions. The skipped checks are deliberately opt-in: the live OpenCode smoke and real tmux integration. Both were also run separately where stated below.

## Platform evidence

### macOS

- Host: macOS 26.6.2 (build 25G83), Apple arm64.
- Bun 1.3.14; tmux 3.7c; OpenCode 1.18.23; `@opentui/core` 0.5.11.
- `AIBRIDGE_TMUX_INTEGRATION=1 bun test tests/integration/tmux-terminal-backend.test.ts`: 1 passed, 0 failed. This exercised create, write, snapshot, detach, recover and terminate against real tmux.
- A local-only OpenCode server was started at `127.0.0.1:4096`. The opt-in test created an exact session, submitted an asynchronous no-tools acknowledgement prompt, and aborted it: 1 passed, 0 failed.
- An actual 80x24 PTY ran the built `aibr tui` against that loopback server. The walkthrough covered project selection, six-field draft editing, immutable dispatch/digest review, the default-Back approval dialog, explicit Tab-to-arm approval, launch, exact tmux terminal creation, read-only attachment, explicit input acquisition, locally consumed Ctrl+], return to read-only, detach without termination, and `q` cleanup.
- The provider displayed `Token refresh failed: 401`. The TUI preserved this as terminal output and did not claim successful task completion. This proves the live failure/unknown presentation path, not a successful model result.
- Normal `q` and Ctrl+C exits emitted alternate-screen, mouse-tracking, bracketed-paste and cursor restoration sequences and returned exit code 0.
- After UI close, the bounded recovery record remained at the configured temporary state directory with the exact terminal/session/pane binding and `active` lifecycle. Automated recovery tests separately prove exact-target reattachment and inspect-only recovery when canonical authority is unavailable.

### Debian/Linux

- Clean disposable `docker.io/oven/bun:1.3.14-debian` container, Debian trixie arm64, Bun 1.3.14, tmux 3.5a, `@opentui/core` 0.5.11.
- Source was mounted read-only, copied into a clean work directory, and installed with `bun install --frozen-lockfile` (120 packages).
- `bun run typecheck`: passed.
- `bun test tests/unit/tui tests/unit/terminal tests/integration/tui-flow.test.ts`: 33 passed, 1 live-agent opt-in skip, 0 failed.
- `AIBRIDGE_TMUX_INTEGRATION=1 bun test tests/integration/tmux-terminal-backend.test.ts`: 1 passed, 0 failed against tmux 3.5a.
- The built native TUI then ran in an actual 80x24 Linux PTY against a local loopback health stub. The walkthrough covered new-draft navigation, bracketed multi-line paste (`Linux\npaste` rendered as bounded single-field text), the default-Back dirty-draft guard, and an actual SGR mouse click on Back that dismissed the modal without discarding the draft.
- Resizing the exact TUI PTY to 59x17 and delivering `SIGWINCH` produced the minimum-size fallback (`Terminal is 59x17; minimum is 60x18.`). Input while below the minimum had no navigation effect; restoring 80x24 returned to the same project state.
- The walkthrough exposed a stale dirty flag after explicitly confirming draft discard. A dedicated `discard-draft` reducer transition now clears the new draft or restores the current proposal for a revision. Unit regressions cover both paths, and the fixed build was recopied and rerun in the same clean container: after Discard, the next `q` closed immediately rather than reopening confirmation.
- Independent follow-up review then reproduced a cross-run variant in which a new draft could retain an older run's proposal. Loading a draft now retains prior run state only when project, run and task identities all match; discard and proposal revision independently enforce the same binding. The exact prior-run/new-draft/discard regression passes.
- Normal `q`, Ctrl+C, externally delivered SIGHUP, and Ctrl+D/EOF each emitted alternate-screen, mouse-tracking, bracketed-paste and cursor restoration sequences and returned to the container shell. The disposable container was then exited and removed.

The Linux checks prove native loading, real PTY rendering/input/resize behavior, lifecycle cleanup, orchestration flow and actual tmux backend behavior. The loopback server in the interactive walkthrough was a health stub; provider-valid completion is tracked separately below and is not inferred from this evidence.

## Core-state visual

[milestone-1-core-states.svg](./milestone-1-core-states.svg) is generated by `bun scripts/render-m1-evidence.ts` from the deterministic end-to-end harness. It contains six 80-column rendered states: authorized project, draft, immutable proposal, exact approval guard, working session and read-only terminal. The generator drives the same shell, application service, runtime and terminal interfaces as the acceptance test; it does not hand-author screen text.

## Final keymap

| Input | Context | Behavior |
| --- | --- | --- |
| Tab / Shift+Tab | Command/form/dialog | Move through every available field/action; dialogs start on Back |
| Enter | Focused action/dialog | Activate; destructive dialog action works only after explicit arming |
| Escape | Form/dialog/screen | Leave field, dismiss, or navigate back; dirty draft opens discard confirmation |
| Up / Down | Project list | Select authorized project |
| PageUp / PageDown | Full proposal/dialog | Page wrapped content |
| F1 or `?` | Command mode | Help |
| `n` | Project/session | New run; deny pending permission in session |
| `a`, `r`, `e` | Proposal | Approve dialog, reject dialog, revise |
| `f`, `v`, `t` | Session | Refresh/reconcile, result, read-only terminal |
| `1` | Pending permission | Allow once through confirmation |
| `c`, `x` | Run/session | Cancel or terminate through distinct confirmation |
| `i`, `o`, `d` | Terminal command mode | Request input, explicit reasoned takeover, detach |
| Ctrl+] | Terminal input mode | Consume locally, release input and return to command mode |
| `q`, Ctrl+C, Ctrl+D | Command mode | Close UI; managed session continues; dirty draft is guarded |

## Remaining manual gate

## Big Pickle compatibility probe

- A local OpenCode 1.18.23 server configured with `opencode/big-pickle` accepted an unauthenticated direct `opencode run --attach` request and returned a model response.
- Raw `prompt_async` with an explicit Big Pickle model and no custom tool policy also succeeded.
- The free provider rejected both AIBridge policy encodings tested: a per-prompt false-tools map and native session deny rules. The provider returned `OpenCode's free tier can only be used from within OpenCode`.
- A proposed adapter workaround was independently reviewed and reverted because it could silently omit a prompt policy and cache stale model selection. AIBridge's original asynchronous prompt plus explicit system/tools restriction path remains intact.
- No permission restriction was removed and no unrestricted AIBridge prompt was counted as milestone evidence.

## Gate disposition

The independent code/safety review is PASS after all reproduced findings were remediated. The supported-platform Linux interactive PTY requirement is exercised, and the exact gate commands pass.

On 2026-09-20 the product owner narrowed first-phase acceptance to opening OpenCode and managing its session/terminal state. Under that explicit scope, credential-valid model completion and a second live TUI process reattaching the same session are deferred rather than release blockers. Existing evidence covers live TUI/OpenCode/tmux state controls, retained recovery metadata, real-tmux detach/recover behavior, and deterministic exact TUI recovery. It does **not** claim that a successful restricted Big Pickle result or a second-process live reattachment was demonstrated.

Milestone 1 is complete under this revised acceptance boundary. Provider-result compatibility and an additional live close/reopen exercise remain documented follow-up work; UNKNOWN continues to be the required presentation when result evidence is absent.

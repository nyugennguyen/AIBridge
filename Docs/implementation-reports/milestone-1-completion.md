# Milestone 1 completion report

Completion date: 2026-09-20

Status: **COMPLETE for the product-owner's revised opening-and-state-management scope**

## Scope delivered

Milestone 1 delivers a local `aibr tui` vertical slice that:

- lists only authorized profile projects;
- creates and revises a one-task run draft;
- renders the immutable dispatch envelope and digest before approval;
- requires explicit, exact approval before launch;
- adapts the loopback OpenCode SDK to the Milestone 0 runtime contract;
- creates and manages exact tmux terminal bindings;
- starts terminal viewing read-only, with explicit bounded input ownership and takeover;
- detaches without terminating, persists bounded recovery metadata, and recovers exact bindings;
- preserves unsupported or ambiguous provider outcomes as UNKNOWN;
- restores terminal state on the tested normal, interrupt, EOF, signal, and failure paths.

The product owner narrowed first-phase acceptance on 2026-09-20: opening OpenCode and managing its session/terminal state is sufficient. Successful provider/model completion and a second live TUI process reattaching the same session are deferred. This is a scope decision, not a claim that those original manual checks passed.

## Task and sub-agent execution

The implementation followed the milestone plan's nine-task dependency order and assignments exactly. The root agent retained integration, shared-file, dependency, and gate ownership.

| Task | Planned sub-agent/model | Delivered |
| --- | --- | --- |
| M1.1 UX state machine and keymap | `architect` — `gpt-6-astra high` | Frozen screens, transitions, focus rules, confirmation behavior, terminal modes, errors, and keymap |
| M1.2 TUI shell and lifecycle | `feature-builder` — `gpt-5.6-terra high` | `aibr tui`, OpenTUI lifecycle, navigation, minimum-size fallback, and cleanup |
| M1.3 Local orchestration service | `subsystem-builder` — `gpt-5.6-sol high` | Typed one-task draft/proposal/approval/launch/status/result commands and in-memory projection |
| M1.4 OpenCode runtime bridge | `feature-builder` — `gpt-5.6-terra high` | Loopback-only runtime adapter, asynchronous prompting, bounded observation, permission handling, UNKNOWN result semantics |
| M1.5 tmux terminal backend | `subsystem-builder` — `gpt-5.6-sol high` | Exact create/attach/snapshot/resize/detach/recover/terminate implementation and private recovery metadata |
| M1.6 Project, run, and approval screens | `feature-builder` — `gpt-5.6-terra high` | Authorized project, six-field draft, proposal, approval, session, result, and error views |
| M1.7 Embedded terminal view | `subsystem-builder` — `gpt-5.6-sol high` | Bounded inert output, read-only default, input ownership, Ctrl+] interception, takeover, resize, and detach |
| M1.8 End-to-end harness | `test-engineer` — `gpt-5.6-sol high` | Deterministic full-flow harness, adversarial state tests, optional live-agent smoke |
| M1.9 UX and safety review | `independent-reviewer` — `gpt-6-astra high` | Independent interaction, lifecycle, authorization, recovery, and final-delta review |

No task was substituted with a differently scoped parallel implementation. The existing M1.7, M1.8, and M1.9 agents were reused for follow-up within their assigned task rather than duplicated.

## Contracts and persistence

- Consumes Milestone 0 schema version 1 contracts without redefining their domain vocabulary.
- Adds provider-neutral local application and runtime adapter boundaries.
- Adds version 1 tmux recovery records containing exact identifiers and bounded metadata only; terminal transcripts and input are not persisted.
- Uses in-memory run/application state as planned. Milestone 3 remains responsible for durable orchestration event storage.

Rollback is removal of the `tui` command and M1 composition while retaining the pre-existing bridge commands and Milestone 0 contracts. Recovery records are isolated under the selected profile's state directory and are not imported into legacy job storage.

## Verification

Final exact gate on 2026-09-20:

```text
bun test tests/unit/tui                         31 passed, 0 failed
bun test tests/unit/terminal                    14 passed, 0 failed
bun test tests/integration/tui-flow.test.ts      5 passed, 1 opt-in skip, 0 failed
bun run typecheck                               passed
bun test                                        577 passed, 2 opt-in skips, 0 failed
bun run build                                   passed
git diff --check                                passed
```

The full suite executed 579 tests across 47 files with 1,545 assertions. The two default skips are the opt-in real OpenCode smoke and real tmux integration. Real tmux was separately exercised on macOS and Debian arm64. Native 80x24 PTY walkthroughs were completed on macOS and Debian, including resize, mouse/keyboard confirmation behavior, detach, safe input handling, and terminal restoration.

The generated core-state evidence is [milestone-1-core-states.svg](./milestone-1-core-states.svg). Detailed command and platform evidence is in [milestone-1-gate-evidence.md](./milestone-1-gate-evidence.md).

## Security review and dispositions

The independent review is PASS for the revised scope. Reproduced findings were fixed and rechecked:

- approval mouse routing could not activate the destructive action through Back;
- the approved deadline remains supervised after attachment exit;
- configured OpenCode authentication is passed through the child environment without entering argv;
- dirty-draft Back is guarded;
- confirmed discard cannot restore proposal state from another project/run/task;
- input ownership is enforced across backend instances and at the final write effect;
- recovered sessions without canonical authority remain inspect-only.

A Big Pickle compatibility probe established that the free model works directly without authentication but rejects AIBridge's custom tool restrictions. An experimental model/session-policy workaround was independently rejected and reverted because it could omit prompt restrictions and retain stale model selection. The final adapter preserves explicit `system` and `tools` restrictions on `prompt_async`. No unrestricted prompt is accepted as evidence.

## Accepted limitations and deferred work

- Successful restricted-provider completion is not demonstrated; absent evidence remains UNKNOWN.
- A second live TUI process reattaching the same surviving session is not demonstrated. Exact recovery is covered deterministically and real tmux detach/recover is exercised.
- OpenCode Big Pickle free-tier compatibility with custom AIBridge restrictions remains unresolved.
- Run/application history remains in-memory; recovery without canonical run history is inspect-only.
- No Claude Code, Codex, mesh enrollment, remote terminal WebSocket, transcript persistence, or automatic controller election is introduced.
- Pre-existing Milestone 0 production obligations F-01 through F-07 remain unchanged.

## Next-milestone prerequisites

Milestone 2 may consume the version 1 runtime/terminal contracts, local OpenCode adapter semantics, conformance fakes, and UNKNOWN confidence behavior. It must not weaken permission restrictions to improve provider compatibility, infer success from idle/silence, or make provider-specific data part of orchestration-domain records.

## Sign-off

- Root/milestone integration: **PASS**
- Independent UX/safety review: **PASS for revised scope**
- Product-owner scope decision: **opening and managing OpenCode state accepted for phase one**


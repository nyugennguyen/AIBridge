# Milestone 1 independent review

Review period: 2026-09-18 through 2026-09-20. Final code-review recommendation: **PASS**. Overall milestone recommendation: **PASS for the product-owner's revised opening-and-state-management scope**.

This is an independent review of the integrated, uncommitted candidate, not an approval based on implementation handoffs. Scope includes the M1 plan and frozen UX state machine, M0 ADRs/contracts/threat model, application service, actual OpenCode/SDK composition, tmux backend and recovery, shell/renderer/controller, package changes, and deterministic acceptance tests. No production files were edited by this reviewer.

## Current findings

### Explicit discard delta — PASS after cross-run scope remediation

The explicit `discard-draft` action is defined in `src/tui/types.ts`, dispatched only through confirmed discard in `src/tui/shell.ts:420`, and handled as a local reducer transition. It resets the stale dirty flag, focus, confirmation, notice and local draft buffers without invoking the service, launching work, cancelling work, or changing approval authority.

The first version restored an older run's proposal when discarding a different new draft. That independently reproduced P2 is now fixed: `src/tui/state.ts:68–73` clears stale run context when the incoming draft's project/run/task triple differs; `state.ts:93–98` independently checks the same triple before restoring a historical proposal; `src/tui/shell.ts:194–198` applies that guard before selecting proposal revision.

The exact independent reproduction now returns Projects with no draft instead of restoring the older run. Additional probes independently mismatched each of project ID, run ID and task ID; none restored the prior proposal. Loading the new draft cleared `state.run`. State regressions retain the same-run revision restore and cover prior run A → new draft B → dirty → discard. Shell regression covers confirmed discard clearing `draftDirty`, while the documented fixed-build Debian retest proves the next q closes. No current reproducible ranked code blocker remains from this delta.

### Follow-up draft-focus delta — PASS after guard remediation

The follow-up focus delta correctly makes all six fields plus Review and Back reachable in both directions, including re-entry after Escape. Local required-field/timeout validation returns focus to the invalid field before service effects. An independent invalid-timeout probe produced no draft edit, proposal creation, or launch commands.

The initial follow-up exposed a dirty-draft Back bypass. It is now fixed at `src/tui/shell.ts:464–468`: Back opens the same discard confirmation as Escape/q. Repeating the exact edit → Tab to Back → Enter reproduction now stays on the draft with `overlay: "discard-confirmation"` and `confirmationArmed: false`. Pressing Enter again dismisses the modal and preserves the dirty draft. No ranked code blocker remains from this delta.

The three prior ranked findings were independently rechecked after remediation:

- **Back click / unintended approval:** `src/tui/shell.ts:482–510` now distinguishes the Back and destructive-control horizontal bounds. Repeating the exact `(0,4)` armed-approval click dismisses the overlay and records neither `proposal.decide` nor `dispatch.launch`. Generic rendered-content action-label scanning is removed. The shell regression also proves a subsequent deliberate destructive-control click retains the exact dispatch/digest behavior.
- **Deadline lost on attachment exit:** `src/tui/session-terminal-runner.ts:56–80` now awaits exact-session abort on attachment exit. Timeout and exit share one abort promise; failed abort attempts retain the supervisor, report UNKNOWN, wait, and retry. The timer is cleared only after confirmed abort. The independent immediate-exit reproduction now calls abort instead of silently returning without one.
- **Custom authentication:** `src/tui/session-terminal-runner.ts:47–54` now maps the configured username and password-variable value into the attachment child's OpenCode environment. An independent probe supplied a custom username/password variable and a conflicting standard password variable: the child received the configured identity and password, and no secret appeared in argv.

Retry/exit audit: an independent attachment-exit probe failed abort twice, then succeeded. Observed three exact-session attempts, two 1,000 ms retry requests, one child kill, and completion only after success. A second probe let the approved deadline expire during an exit-triggered retry: observed two total attempts, one kill, and exit code 1, without a second concurrent abort pump. Retry diagnostics omit transport error details and credentials. Persistent provider failure deliberately retains the supervisor and UNKNOWN state; it does not prove the provider has stopped. This is a source/deterministic finding, not a live-server outage test.

### Release gate — original manual evidence remains incomplete

The durable [gate evidence report](./milestone-1-gate-evidence.md) was read in full for this delta. It records exact versions, automated commands, macOS and Debian real-tmux integration passes, native interactive PTY walkthroughs, the final keymap, and remaining limitations. These platform walkthroughs were executed by the integration lead rather than this reviewer; they are now documented evidence, not inferred from a fake test run.

The macOS evidence covers real TUI → loopback OpenCode → tmux approval, STARTING, read-only attach, input acquisition, local Ctrl+] release, detach, q/Ctrl+C cleanup, and retained exact recovery metadata. A separate live smoke created, asynchronously prompted and aborted a session. Provider output showed token-refresh HTTP 401, so neither proves a successful model result or completed task.

The Debian trixie arm64 native OpenTUI PTY evidence covers actual bracketed paste, SGR mouse Back behavior, dirty discard, 59x17 minimum fallback with state preservation, and q/Ctrl+C/SIGHUP/Ctrl+D restoration sequences. The fixed discard build was recopied and retested; next q closed immediately. This satisfies the previously missing Linux native interaction evidence for those paths. The interactive server was explicitly a health stub, not a credential-valid agent. Ctrl+D evidence establishes the explicit close-key route; it should not be expanded into proof of every possible raw stdin-stream failure.

The `milestone-1-core-states.svg` is transparently identified as a generated deterministic harness visual, not a capture of the live provider session. Retained recovery JSON, fake recovery, the macOS 401 and the Linux health stub do not prove credential-valid completion or a second live TUI process reattaching the same session.

On 2026-09-20 the product owner explicitly narrowed first-phase acceptance to opening OpenCode and managing its state. The reviewer therefore accepts the documented live session controls, real-tmux detach/recovery checks, and deterministic TUI recovery for M1. Successful provider completion and second-process live reattachment are deferred by scope decision; they are not relabeled as demonstrated passes of the original criteria.

## Verification evidence

- `bun run typecheck`: passed.
- `bun test`: **577 passed, 2 skipped, 0 failed; 1,545 assertions; 579 tests across 47 files** independently rerun after the discard cross-run remediation, matching the gate evidence report.
- `git diff --check`: passed.
- Follow-up focus-delta `bun run typecheck` and `bun test tests/unit/tui tests/integration/tui-flow.test.ts`: **35 passed, 1 skipped, 0 failed**, 225 assertions across 7 files. Independent forward/reverse focus probes passed. With required fields filled and timeout zero, review returned focus to Timeout with no edit/proposal/launch effects.
- `opencode attach --help`: confirmed exact session/directory support and authentication defaults described above.
- Read-only inspection of the integrated diff, all new subsystem/test directories, package manifest/lockfile, and release workflow.
- Independent coordinated two-backend ownership-race probe: takeover could not complete while the old owner's write held the shared tmux lock; the first write occurred as client A, takeover then succeeded, and a late A write failed. This no longer reproduces the earlier ownership-write race.
- Independent recovered-controller probe with `mutationAllowed: false`: request input, begin takeover, confirm takeover and send input all failed; owner remained null. This no longer reproduces the earlier recovery bypass.
- Independent mouse, authentication, early-exit, abort-retry and deadline/exit-race probes verified the remediations above without launching an external agent or editing test/production files.
- Build and actual CI execution were not independently rerun by this reviewer; the gate evidence report records a successful build, but a local run is not evidence that remote CI passed. Native platform walkthrough evidence was reviewed as documented lead-executed evidence, not claimed as reviewer-executed.

## Production composition and safety assessment

The terminal is now **wired to the actual OpenCode agent session, not a generic shell**. Bootstrap obtains the provider-session ID and authorized directory from the runtime adapter, starts the tmux-owned runner, and the runner executes `opencode attach <loopback URL> --session <exact provider ID> --dir <authorized directory> --mini`, with profile authentication mapped into the child environment. The backend uses fixed argv, internally generated tmux names, exact pane/session validation, and hex-encoded input rather than interpolating arbitrary terminal input into a shell command. Source inspection establishes this composition; the lead-reported live macOS run additionally demonstrates attachment/input interaction. The provider's token-refresh 401 means successful task completion remains unproven.

The application layer retains exact revision/digest/approval binding and idempotent launch admission, including cancellation-before-launch rejection, changed-policy/path invalidation, and non-replay of uncertain effects. The production adapter uses the asynchronous prompt endpoint and a bounded persistent event pump. Permission handling intersects requested, dispatch and role authority with deny floors, rejects persistent allow and unknown/denied permission grants, and displays a bounded safe identity. Idle or unsupported result inspection remains UNKNOWN rather than fabricated completion.

The registry pins its startup realpath and checks it again at launch. The tmux backend validates exact recovered references and stores bounded private metadata rather than transcripts. Input ownership is shared across backend instances and protected at the final write effect by the same cross-process lock as takeover. Controller queues are bounded, Ctrl+] is consumed locally, detach revokes input, and recovery without canonical authority is inspect-only at the controller boundary. The shell now awaits detach before its completion can lead to CLI exit. These are meaningful source/test findings, not proof of hard-crash recovery or terminal portability.

Terminal output is polled while visible, rendered as a bounded tail with status/footer, and never treated as completion evidence. Proposal/modal text wraps by physical rows. Headless coverage exercises compact rendering and long-prompt reachability. Mouse confirmation routing now separates Back from confirmation, and arbitrary displayed text no longer becomes an action through label scanning. Automated evidence does not establish interactive terminal portability.

The direct dependency addition is pinned `@opentui/core` 0.5.11 with its platform/native dependency effects in the lockfile. CLI integration is lazy and requires interactive input/output TTYs. No additional agent providers, remote terminal WebSockets, mesh enrollment, transcript persistence, or replacement terminal emulator was introduced. The separate publish workflow is not required for M1 behavior and does not supply the missing manual or live-provider validation. This review does not grant publishing authorization or clear the pre-existing M0 F-01–F-07 production obligations.

## Completion and guardrail matrix

| Requirement | Assessment |
| --- | --- |
| Revised local opening/state-management flow | PASS: deterministic flow, live macOS attachment/input controls, and real-tmux state operations are documented; successful provider completion is deferred. |
| No preapproval launch; edits invalidate approval | PASS: exact service guards and independently rechecked Back-click regression. |
| Close/reopen preserves tmux/OpenCode session | Source, deterministic recovery, and real-tmux detach/recover coverage PASS; a second live TUI process demonstration is explicitly deferred, not claimed. |
| Resize, read-only viewing, explicit takeover, bounded safe input | Core tests/race probes PASS; documented native Linux resize/mouse and macOS live read-only/input interaction support the platform behavior. |
| All shutdown paths restore terminal | Lifecycle/awaited-detach tests PASS; documented macOS q/Ctrl+C and Linux q/Ctrl+C/SIGHUP/Ctrl+D PTY restoration support tested native paths, without claiming every OS/terminal failure mode. |
| Unknown/unsupported never displayed as success | PASS in inspected service/adapter paths and tests; attachment exit is not accepted as task completion. |
| Existing CLI/bridge/security/job tests remain green | PASS locally in the full suite. |
| Deterministic fake-agent E2E passes in CI | PASS locally; remote CI evidence not independently available. |
| macOS and Debian/Ubuntu manual smoke | PASS for revised scope: native PTY/backend evidence is documented for both families; provider result and second-process reattachment are deferred. |
| Only local OpenCode; no mesh/WebSocket/new-provider scope | PASS in inspected candidate. |
| UI separated from filesystem/tmux/SDK/network effects | PASS: bootstrap/adapters own production effects. |
| No raw transcript retention by default | PASS in inspected persistence paths. |
| Explicit user approval only | PASS in inspected paths and independent confirmation regression. |
| Dirty-draft navigation preserves explicit discard intent | PASS: exact Tab/Enter Back reproduction now opens unarmed confirmation; default Enter preserves the dirty draft. |
| Confirmed discard remains scoped to the current draft | PASS: independent exact-scope and each-ID-mismatch probes reject unrelated history; new draft context is cleared and same-run revision history retained. |
| No input to wrong session/after ownership loss | Independent exact-binding, shared-lock and recovery probes PASS; no current reproduced input-ownership bypass. |
| Approved timeout remains effective outside TUI lifetime | PASS in production composition and independent exit/retry/deadline probes; live-provider demonstration outstanding. |

Final recommendation: **PASS the bounded code review and the product-owner's revised M1 gate**. Keep fail-closed restrictions unchanged. Provider incompatibility, successful restricted-model completion, and second-process live reattachment remain documented follow-up limitations rather than reasons to run unrestricted. The approval-click, supervisor lifetime, authentication, dirty-Back and cross-run discard findings are resolved and are not retained as open blockers. The documented native Debian PTY walkthrough is credited only for the paths it actually exercised.

The final reversion audit independently confirmed that session creation has no experimental permission/model injection, `prompt_async` again carries the approved `system` and `tools` restrictions, and no stale model cache remains. The reviewer reran typecheck, diff checks, and the full suite: 577 passed, 2 opt-in skips, 0 failures. No production files were edited by the reviewer.

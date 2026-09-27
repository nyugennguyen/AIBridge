# Milestone 1 UX state machine and keymap

Status: frozen for M1.1 implementation handoff; subject to the independent M1.9 gate.

Scope: the local, one-task OpenCode workflow in [the Milestone 1 plan](../implementation-plans/milestone-1-single-node-tui.md). This document consumes the [M0 completion report](../implementation-reports/milestone-0-completion.md), [domain boundaries](../adr/0001-canonical-domain-and-module-boundaries.md), [versioned contracts](../adr/0002-versioned-contracts-and-adapter-boundaries.md), [idempotency decisions](../adr/0003-event-store-and-idempotency.md), and [recovery decisions](../adr/0004-controller-leases-and-recovery.md).

## Ownership and implementation boundary

The TUI is a client of a local application service. The renderer sends an intent and renders the resulting view model. UI components never read stores or profiles, invoke tmux, call an SDK, or construct runtime commands. The application service owns authorization, proposal revisions, approval, command identity, launch admission, lifecycle interpretation, result evidence, and recovery. Adapters own provider/process/terminal details.

M1.2 owns the pure reducer, key routing, layout, renderer lifecycle, and ephemeral view-model types. M1.3 owns the injected application-service interface and its canonical snapshots. M1.5 owns terminal attachment and ownership enforcement. M1.6 supplies the screens; M1.7 supplies the terminal presentation and bounded input/output bridge. This document freezes behavior and action names; implementation agents coordinate their actual service signatures through the lead before consuming them. No new TypeScript contract is necessary for M1.1.

Use the existing `Project`, `Run`, `Task`, `Dispatch`, `Approval`, `Session`, branded identifiers, `ContractError`, `Result<T>`, `AgentResult`, `RuntimeSessionReference`, and `TerminalReference` types. Do not create competing domain statuses, IDs, approval records, or event payloads. View-model tags below describe UI state only. Any new persisted recovery record must have a strict versioned schema owned by the service/backend implementation; this UI document grants no authority to unvalidated metadata.

The local store/projections begin in memory as required by M1.3. That does not make a process restart a fresh execution authorization. Surviving sessions are recovered through the owning node/backend, and missing receipts or approval evidence block mutation rather than trigger replay. Production event-store behavior remains governed by ADRs 0003–0004 and is implemented in its owning milestone.

CLI integration is `aibr tui --profile <name>`. A profile is required for the vertical slice, validated through the existing profile-name boundary. `tui --help` and `--version` remain usable without a TTY. Interactive entry requires both input and output to be TTYs; failure prints a concise error and returns the existing failure exit code before renderer creation. Existing `setup`, `start`, `serve`, `status`, and hidden `_opencode` semantics remain unchanged. Profile/project loading belongs to the service bootstrap, never to a renderable.

## State dimensions and invariants

State is explicit and has independent dimensions. A terminal attachment cannot change whether a task succeeded; changing the visible screen cannot authorize a command.

| Dimension | Values / meaning |
| --- | --- |
| Workflow | `project-selection`, `run-draft`, `proposal-review`, `proposal-rejected`, `proposal-revised`, `starting`, `agent-idle`, `agent-working`, `agent-blocked`, `agent-unknown`, `agent-completed`, `agent-failed`, `run-cancelled`, `result-review`, `recovering` |
| Visible screen | `projects`, `draft`, `proposal`, `session`, `terminal`, `result`; screen navigation preserves the service's workflow state |
| Terminal attachment | `detached`, `attaching`, `read-only`, `requesting-input`, `input-owned`, `detaching`; carries an exact terminal/session/project/client binding when attached |
| Keyboard mode | `command` or `terminal-input`; text-field editing is focus within command mode, not terminal input |
| Overlay | None, help, approval confirmation, rejection confirmation, cancel confirmation, termination confirmation, takeover confirmation, discard/quit confirmation, or recoverable error |
| Shell state | `booting`, `ready`, `too-small`, `fatal`, `closing`, `closed` |
| Pending operation | None or one mutation with operation identity, target identity and expected proposal revision/digest; read refreshes may be independent |

At most one modal owns focus. At most one mutation is admitted for a target at a time. Pending mutations disable their initiating controls and competing revision/launch/cancel controls; repeated Enter or double activation cannot allocate another launch. A service response updates only the scope and revision it names. Late refreshes cannot replace a newer proposal, reselect another project, change input ownership, or regress a confirmed terminal outcome.

`terminal-input` is legal only when all of these are true: the terminal screen is visible, there is no overlay, the shell is ready, the viewport is usable, the exact active channel is attached, the backend has confirmed this client's current input ownership, and the service currently permits input for that binding. Ownership alone is insufficient. Losing any condition synchronously disables forwarding before another input byte is accepted.

The service is the source of truth. The UI may show pending progress, but cannot optimistically show approval, ownership, successful launch, termination, cancellation, or completion before a successful typed result. `idle`, no new output, disconnected observation, exit-looking terminal text, missing metadata, and unsupported provider inspection never become `completed`.

## Main transition table

Action names in this table are UI intents. They are mapped to typed application commands by the service boundary; they are not new variants of the frozen orchestration command union.

| Current workflow | Intent or observation | Guard and application action | Next workflow / visible result |
| --- | --- | --- | --- |
| Booting | Initial load succeeds | Load authorized local projects and recoverable session summaries | `project-selection`; focus project list |
| `project-selection` | `select-project` | Service confirms exact project/path binding and available local OpenCode installation | Project detail and its runs/sessions remain on projects screen |
| `project-selection` | `new-run` | Selected project is authorized; create one-task draft | `run-draft`; focus goal field |
| `run-draft` | `review-proposal` | Validate fields; service produces immutable dispatch and digest | `proposal-review`; focus proposal heading/details, not Approve |
| `run-draft` | `discard-draft` | Dirty draft requires discard confirmation | `project-selection`; no dispatch or process effect |
| `proposal-review` | `approve` | Open exact-ID/digest confirmation; explicit final confirmation calls approval then guarded launch admission | `starting` after successful launch admission; progress distinguishes recording approval from launching |
| `proposal-review` | `reject` | Confirm rejection of this dispatch ID/digest; service records rejected decision | `proposal-rejected`; no runtime invocation |
| `proposal-review` or `proposal-rejected` | `edit-proposal` | No launch in flight; service starts a revision; invalidate old actionable approval | `proposal-revised`; draft fields show approval-required notice |
| `proposal-revised` | `review-proposal` | Service creates new dispatch ID and next attempt, recomputes digest | `proposal-review`; new proposal requires explicit approval |
| Proposal states | `cancel-run` | Confirm cancellation; service closes unlaunched work | `run-cancelled`; no launch |
| `starting` | Runtime confirms session | Bind canonical session and terminal; observe typed state | `agent-idle`, `agent-working`, or `agent-blocked`; session screen |
| `starting` | Definite launch rejection/failure | Service knows no ambiguous external effect remains | `agent-failed`; show safe error and explicit next action |
| `starting` | Timeout, lost reply, uncertain invocation | Do not send launch again; request reconciliation | `agent-unknown`; show “Launch outcome unknown” and disable retry launch |
| Any live agent state | Typed lifecycle observation | Validate target/revision and normalized state | Corresponding `agent-*` state without stealing focus |
| `agent-blocked` | `respond` | Exact outstanding request, permitted bounded decision, explicit user submission | Remain blocked/pending until runtime evidence reports another state |
| Live/unknown state | `refresh` | Read/inspect/reconcile only; no prompt or launch replay | Keep current state or apply verified observation |
| Live agent state | `interrupt` | Explicit service control action; current authority and binding required | Pending interruption; remain live/blocked/unknown until confirmed observation |
| Live/unknown state | `cancel-run` | Separate confirmation; service prevents future work and requests cancellation of the active attempt | Pending cancellation; `run-cancelled` only on confirmed application outcome; show process status separately |
| Live/unknown state | `terminate-session` | Separate destructive confirmation naming the session; current authority required | Pending termination; confirmed outcome or `agent-unknown` if ambiguous |
| Any live state | Verified completed result | Service validates reliable completion evidence | `agent-completed`; announce result available without changing focused input |
| Any live state | Verified failed result | Service records failure evidence | `agent-failed`; announce result available |
| Completed, failed, cancelled, or unknown | `review-result` | Read safe result/evidence; unknown remains explicitly unknown | `result-review`; outcome label preserves the actual status |
| `result-review` | `back-to-session` / `back-to-projects` | Navigation only | Restore selected session/project with unchanged outcome |
| Project/session list | `recover-session` | Service validates exact node/project/session/terminal mapping and inspects provider | `recovering`, then verified agent state or `agent-unknown`; attachment defaults read-only |

An approval result followed by an uncertain launch result must not redisplay an enabled “Approve and start” button. Keep its command/dispatch identity pending reconciliation. If the service proves the launch was never admitted and authorization remains valid, it may offer an explicit start action for that same approved dispatch; the UI cannot decide this from a missing session row. Failed completed attempts can only be retried through a new proposal/attempt and approval.

Cancel, interrupt, terminate and close are distinct. Closing/detaching preserves processes. Interrupt asks the runtime to stop current work and is not proof of task cancellation. Cancel run prevents further scheduling and follows the service's active-attempt cancellation policy; it does not silently turn into process termination. Terminate stops the selected session through a separately confirmed application command. An unresponsive process can remain visible as unknown even after the run is cancelled.

## Proposal review and approval invalidation

The proposal screen displays project, resolved project-path label, goal/task, target node, runtime/installation, optional model, full prompt, effective role/rule/context references, requested capabilities, permission restrictions, timeout, attempt, and digest. It provides a scrollable full-detail view for fields that do not fit. Sensitive values are redacted by the service; hidden/redacted values are labeled and are not reconstructed by the UI. A digest is a content identifier, not an approval badge.

Approval uses a confirmation containing the exact dispatch ID, attempt, current digest and a concise permission/target summary. “Back” is initially focused; activating the separately focused “Approve and start” control is the final user intent. The service rechecks the displayed identity/digest against its current proposal, records the approval, and admits launch only after all authorization checks pass. An approval alone cannot bypass project-path checks or controller authority.

Beginning revision removes the old proposal's actionable approval immediately in the view model. Editable M1 fields are goal/task text, prompt, available model selection and bounded timeout; policy, role/context, target or installation changes initiated elsewhere have the same invalidation rule. While a revision is open, old approval controls remain disabled. Saving creates a new immutable proposal, dispatch ID and attempt; it never mutates the approved envelope in place. A stale approval response cannot approve the revision. Discarding revision returns to historical proposal details with an explicit re-review action, never automatic launch.

Reject leaves an auditable rejected proposal and offers “Revise” or “Back to projects.” It does not cancel the run or erase its history. A later revision receives a new attempt. A changed controller epoch or material policy/context change also requires a fresh proposal and approval under the M0 contract.

## Layout, focus and accessibility

Wide layout at 100 or more columns uses project/run navigation, the primary detail pane and a compact context/status pane. Compact layout at 60–99 columns shows one primary pane with breadcrumbs and explicit Back actions; all proposal information remains reachable by scrolling or the full-detail view. The footer always states current mode, current action hints, and safe exit key.

Minimum usable size is 60 columns by 18 rows. Below either dimension, show a plain resize message containing current and minimum dimensions plus “q: close UI; sessions continue.” Preserve selection, draft text, scroll positions and pending service operations. Immediately enter command mode, disable byte forwarding, and release input ownership best-effort. Do not launch, approve, take over input, or forward terminal bytes in this fallback. Returning to usable size restores the prior screen/focus where possible, but stays read-only until input is explicitly requested again.

Focus order is deterministic: screen navigation, primary list/form, detail/scroll region, available action buttons. Tab/Shift+Tab move within that order. A modal traps focus within its own visible controls and initially selects the non-destructive action. Closing it restores the previous logical focus if it still exists, otherwise the screen heading. An async status update does not move focus. A deleted/unavailable list row selects its nearest surviving neighbor and announces the change.

Every control has a text label and visible focused state. Status appears as words such as `[WORKING]`, `[BLOCKED]`, `[UNKNOWN]`, `[READ ONLY]`, and `[INPUT OWNED]`; color is supplemental. Errors include a concise message and actionable next step. Long labels are truncated visually with full text available in detail. Screen-reader/plain-text expectations are verified during M1.9; M1.1 does not claim terminal accessibility certification.

All actions are reachable through Tab/Shift+Tab and Enter without function keys, mouse, color recognition, timing-dependent multi-key sequences, or an undocumented shortcut. Mouse activation follows the same focus and guard rules. Clipboard content/paste into form fields is text, never a shortcut or application command.

## Frozen keymap

Single-letter shortcuts operate only in command mode when focus is not in an editable text field and no modal owns the key. Buttons remain the accessible alternative. Disabled actions remain labeled with their reason and cannot activate from a shortcut.

| Key | Context | Meaning |
| --- | --- | --- |
| Tab / Shift+Tab | Command mode, including dialogs | Next/previous focusable control |
| Up/Down; PageUp/PageDown | Focused list or scroll region | Navigate rows or scroll; never change the selected runtime implicitly |
| Home/End | Focused list/scroll region | First/last item or boundary; ordinary text editing when a text field owns focus |
| Enter | Command mode | Activate focused button/list row; insert newline in a multiline text field |
| Space | Focused button/checkbox | Activate/toggle; ordinary text in a text field |
| Escape | Command mode | Dismiss dialog/help or navigate Back; dirty draft navigation asks to discard |
| F1 or `?` | Command mode outside editable fields | Open key help; Help button is always reachable |
| `n` | Projects screen | New one-task run for selected project |
| `e` | Proposal screen | Begin revision when allowed |
| `a` | Pending proposal | Open approval confirmation; never approve immediately |
| `r` | Pending proposal | Open rejection confirmation |
| `t` | Session screen | Attach/open selected terminal read-only |
| `i` | Attached terminal in command mode | Request input ownership; enter terminal-input mode only after successful confirmation |
| `o` | Read-only terminal owned by another client | Open explicit takeover confirmation, including owner and reason |
| `d` | Terminal screen, command mode | Detach view and release input; keep process/session alive |
| `x` | Session screen, command mode | Open terminate confirmation; no direct process effect |
| `c` | Run/session screen, command mode | Open cancel-run confirmation |
| `v` | Session screen with result | Review result/evidence |
| `f` | Project/session/result screen | Refresh/reconcile view without replaying effects |
| `q` | Command mode outside editable fields | Close UI; if draft is dirty, confirm discard; sessions continue |
| Ctrl+C | Command mode | Interrupt UI and run cleanup; do not terminate managed sessions |
| Ctrl+] (`0x1d`) | Terminal-input mode | Consume locally, stop forwarding, return to command mode and release input best-effort |
| Other keys, including Escape, Tab and Ctrl+C | Terminal-input mode | Forward only to the exact currently owned/authorized channel; Ctrl+C targets the terminal application, not the TUI |

The terminal footer and input border always display `INPUT — Ctrl+] returns to commands`; read-only mode displays `READ ONLY — i requests input`. Ctrl+] is reserved in this milestone and cannot be sent to the agent. The input decoder consumes its control byte before any forwarding, including within a received input chunk; bytes after it are not forwarded as a tail of that chunk. Do not buffer it waiting for a second key. Incoming paste is bounded terminal data, never routed as UI shortcuts, and cannot bypass this reserved control-byte rule.

Terminal data is not a source of local hotkeys. Output escape sequences, links or text cannot activate local approval, ownership, navigation or process controls. Renderer/input cleanup must disable forwarding before detaching or destroying the renderer.

## Terminal attachment, ownership and resize

`attach-terminal` always yields read-only viewing first, regardless of who last owned input. Show the canonical session/terminal/project label throughout attachment. A channel changing identity is detached; it is never silently rebound while retaining queued keys or ownership.

`request-input` is separate from attachment. While pending, the UI remains command/read-only and drops input intended for the terminal. Success must name this client as current owner of the exact terminal. A conflict leaves read-only mode and offers an explicit takeover dialog; there is no automatic takeover. The dialog identifies the selected session and current owner, requires a nonempty reason, defaults to Back, and calls the service's authorized takeover operation only after confirmation.

Ownership change is enforced at the backend's write boundary, not merely by the UI badge. On ownership loss, terminal closure, channel failure, project switch, recovery freeze or revoked authorization: synchronously stop forwarding, discard unsent input, leave terminal-input mode, and display the reason. Best-effort release failure never restores local input mode. A late ownership-success response for a closed/replaced attachment is ignored and its grant is released where possible.

Leaving input mode releases ownership; leaving the terminal screen detaches the view. Neither action terminates or interrupts the session. Quitting, renderer exceptions, EOF and termination signals use the same idempotent release/detach cleanup. A crash that prevents cleanup must still leave server/backend enforcement able to reject writes from a dead or replaced client; backend liveness/ownership reconciliation is an M1.5/M1.7 responsibility.

Terminal dimensions use the existing integer range 1–1000 for both axes. Compute the usable terminal content rectangle after borders/footer; do not pass screen dimensions blindly. Ignore nonfinite/unavailable dimensions, floor valid positive measured dimensions, clamp to bounds, and send only a nonzero content area. Coalesce resize bursts to the most recent dimensions; queued stale resizes cannot target a newly selected terminal.

Only the current input-owning attachment resizes a shared live terminal. Read-only viewers resize their viewport and request bounded snapshots without changing another owner's process dimensions. When no input owner exists, preserve the process dimensions until an authorized client acquires input. Resize while input-owned does not forward keystrokes or change process outcome; dropping below minimum size releases input as above.

Use bounded reads and the backend's declared buffer cap, no larger than the existing 1 MiB schema ceiling. The terminal panel has a bounded presentation buffer, exposes truncation as text, and retains no raw transcript by default. M1.7 supplies only the rendering/stream support required by tmux/OpenCode; unsupported terminal rendering is visible and must never be interpreted as successful runtime completion.

## Errors and recovery

Recoverable errors are scoped banners/dialogs over the last usable screen. Preserve unsaved text and selection. Display the safe `ContractError.message`, category-appropriate next action, and correlation identifier where useful; do not display stacks, credentials, raw environment values, provider exception dumps or unredacted terminal content in logs.

| Condition / shared error category | UX and permitted recovery |
| --- | --- |
| `validation` | Point to the field or unsupported input; return focus there; no side effect |
| `approval_required` | Return to current proposal review; show what changed; never silently reuse approval |
| `policy_denied` | Explain denial safely; edit permitted fields or return; no “force” action |
| `unsupported_capability` | Disable the unavailable action and explain it; retain read-only inspection where supported |
| `conflict` | Refresh the exact proposal/ownership state and require new explicit intent; do not retry a stale action automatically |
| `stale_epoch` | Freeze mutation/input and enter recovery/read-only mode; service must reconcile authority |
| `transient_transport` / `timeout` | Retry reads explicitly; mutation outcomes are unknown until receipt/provider reconciliation proves their status |
| `runtime_failure` | Show failed result only when failure is established; uncertain launch/control outcomes remain unknown |
| `internal_failure` | Safe error with correlation; block affected actions; shell becomes fatal if identity/input/lifecycle integrity cannot be trusted |

Fatal shell states include renderer initialization failure, unrecoverable render exception, or failure to maintain the active channel/input binding safely. Disable all input forwarding immediately, run cleanup once, restore terminal modes/cursor/alternate screen/handlers, and print a concise diagnostic after restoration. Fatal cleanup does not send session termination. Repeated signals cannot trigger duplicate teardown or a second application mutation. The terminal's original mode is captured before modification and restored even when renderer construction only partly succeeds.

On close/reopen, discover only terminals belonging to the authorized node/project and validate their canonical recovery metadata. Reconnect to the same terminal/provider session when that binding is proven; do not start a new process merely because an in-memory row is absent. Recovered attachments begin read-only. Reacquiring input requires fresh explicit intent and current service authorization.

M1's in-memory projections need not reconstruct a complete historical run after a TUI process exits. The UI distinguishes “Recovered session; run history unavailable” from a fully recovered run. A recoverable terminal can remain viewable while runtime state is unknown. Missing dispatch approval, command receipts, current authority, or session identity means inspect-only recovery with mutations disabled. Recovery never manufactures approvals or lease epochs, restarts an ambiguous launch, sends the original prompt again, or equates a tmux pane's survival with provider success. If safe recovery cannot prove a binding, show it as unavailable/quarantined rather than attach another project's session.

The service/backend must retain enough bounded, validated canonical session/terminal metadata to find its own surviving sessions; storing this metadata is distinct from claiming a durable event-store implementation. The owning implementation freezes its exact versioned record and write boundary before use. Tests must demonstrate that absence or corruption fails closed. The M1 release note must state the in-memory history limitation; durable authority/receipt loss remains subject to ADRs 0003–0004.

## Tabletop walkthrough and acceptance evidence

These scenarios are the M1.1 tabletop specification, not claims that the renderer or adapters already implement them. M1.2–M1.8 turn them into deterministic tests and manual recordings.

| Scenario | Walkthrough | Required end state / assertion |
| --- | --- | --- |
| Success | Select project → New run → type goal → Review → inspect full envelope → Approve confirmation → explicitly Approve and start → working → attach read-only → request input → Ctrl+] → verified result → review | Exactly one approved dispatch/launch; result reports success only with evidence; escape byte never reaches provider |
| Reject then revise | Review proposal A → Reject confirmation → rejected → Revise → change prompt → Review proposal B → approve B | A remains rejected; B has new ID/attempt/digest; no launch or approval is inherited from A |
| Edit invalidation/race | Review A → begin edit → new revision; late response for A arrives → Review B | B stays approval-required; stale response cannot enable launch or replace B |
| Cancel before launch | Draft/proposal → Cancel run confirmation → confirm | No runtime invocation; cancellation is distinct from rejection |
| Cancel while working | Working → Cancel run confirmation → confirm → provider does not immediately acknowledge | Cancellation remains pending/unknown as appropriate; process liveness is shown; UI does not claim termination |
| UI crash | Attached input-owned → renderer throws during output | Forwarding stops before teardown; cleanup restores host terminal; managed tmux/OpenCode survives; error contains no raw transcript |
| Crash at launch boundary | Approve → invocation may happen → connection/process fails before result | Reopen shows recovery/unknown; no automatic launch/prompt replay; verified existing session may be restored |
| Resize | Wide → compact → below 60x18 while input-owned → usable again | State/text retained; small fallback accepts no effects/input; process survives; return is command/read-only; only current owner can resize process |
| Close/reopen | Working → Ctrl+] → q → launch `aibr tui --profile …` again → select recovered session | Same terminal/session survives; default read-only; lost history is labeled; no fresh prompt or process is created |
| Unknown provider state | Terminal is silent or provider inspection unsupported | `[UNKNOWN]` stays visible; Refresh/Inspect/Back available; no success or automatic retry |
| Ownership loss | Client A owns input; B explicitly takes over; A has queued bytes | Backend rejects A writes; A drops queued bytes, switches command/read-only, and shows loss; B's session receives no A tail bytes |
| Recoverable denial | Approve displayed envelope → project/path authorization changed | Typed denial returns to usable proposal view; no launch; error never offers bypass |
| Fatal startup / non-TTY | Non-TTY invocation, or renderer fails partway through creation | Concise failure; no runtime action; terminal cleanup on partially initialized renderer; existing CLI help remains usable |

M1.1 acceptance criteria are met by the explicit workflow/attachment/shell dimensions, transition and key tables, approval revision guards, recovery/error semantics, resize rules, and the tabletop coverage above. There is no M1.1 renderer or runtime claim. The lead must freeze M1.2/M1.3 service signatures and any new recovery-record schema before their consumers fan out; M1.9 remains the implementation safety and UX gate on macOS and Debian/Ubuntu.

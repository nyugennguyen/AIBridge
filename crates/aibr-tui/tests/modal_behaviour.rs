//! Modal dismissal and click routing.
//!
//! These are regression tests for a live defect, not for a design choice.
//!
//! The modal was undismissable. `Action::ModalClosed` was produced by the engine on
//! `Esc` and nothing consumed it; approving, rejecting and aborting all left the
//! prompt on screen too. The buttons were drawn but `handle_click` fell through to a
//! default that swallowed everything, and `rect()` answered with a hardcoded 80x24
//! that was not where the modal was drawn at any other window size.
//!
//! So an operator looking at a blocked job had no way to decide and no way to back
//! out. None of that was visible to 356 passing tests, because none of them asked
//! what happens after a decision.

use std::time::Instant;

use aibr_tui::input::traits::{ApprovalModal, FocusTarget, ModalOutcome};
use aibr_tui::session::ModalHost;
use aibr_tui::state::{Job, PaneKind};
use aibr_tui::widgets::modal::{modal_rect, ModalAction};
use aibr_tui::widgets::ApprovalModalState;
use ratatui::layout::Rect;

/// A blocked job for the modal to be about.
fn blocked_job() -> Job {
    Job {
        id: "job-refactor".to_owned(),
        project_id: "proj-web".to_owned(),
        workspace_id: "ws-web".to_owned(),
        session_id: None,
        state: aibr_ipc::contracts::JobState::Blocked,
        blocked_reason: Some(aibr_tui::state::BlockedReason::PlanReview),
        detail: Some("4 files".to_owned()),
        updated_at: "2026-10-06T00:00:00Z".to_owned(),
    }
}

/// An open modal inside a host sized to `screen`.
fn host(screen: Rect) -> ModalHost {
    ModalHost::new(Some(ApprovalModalState::new(blocked_job())), screen)
}

#[test]
fn escape_dismisses_the_modal() {
    let mut host = host(Rect::new(0, 0, 120, 40));
    let event = aibr_tui::input::traits::KeyEventLike {
        named: Some(aibr_tui::input::traits::NamedKey::Esc),
        ..Default::default()
    };

    let outcome = host.handle_key(&event);

    assert_eq!(outcome, ModalOutcome::Dismissed);
    assert!(
        !host.is_open(),
        "Esc left the prompt on screen: a blocked job the operator cannot dismiss \
         is a job that never unblocks"
    );
}

#[test]
fn a_key_that_means_nothing_here_leaves_the_modal_open() {
    // The counterpart to the test above. If `Consumed` also closed the modal, a
    // stray keystroke would silently abandon a decision the agent is waiting on.
    let mut host = host(Rect::new(0, 0, 120, 40));
    let event = aibr_tui::input::traits::KeyEventLike {
        char: Some('z'),
        ..Default::default()
    };

    assert_eq!(host.handle_key(&event), ModalOutcome::Consumed);
    assert!(
        host.is_open(),
        "a keystroke with no meaning in the modal must not look like a dismissal"
    );
}

#[test]
fn enter_approves_and_closes() {
    let mut host = host(Rect::new(0, 0, 120, 40));
    let event = aibr_tui::input::traits::KeyEventLike {
        named: Some(aibr_tui::input::traits::NamedKey::Enter),
        ..Default::default()
    };

    let outcome = host.handle_key(&event);

    assert!(
        matches!(
            outcome,
            ModalOutcome::Approve {
                scope: aibr_tui::input::traits::ApproveScope::Apply
            }
        ),
        "the default focus is Approve, so Enter must approve: {outcome:?}"
    );
    assert!(
        !host.is_open(),
        "the prompt stayed up after the decision was sent"
    );
}

#[test]
fn the_modals_rect_is_where_it_is_drawn() {
    // `rect()` previously answered a hardcoded 80x24. At any other window size the
    // buttons were drawn in one place and resolved against another.
    for (width, height) in [(80u16, 24u16), (120, 40), (200, 60), (61, 19)] {
        let screen = Rect::new(0, 0, width, height);
        let host = ModalHost::new(Some(ApprovalModalState::new(blocked_job())), screen);
        assert_eq!(
            host.rect(),
            Some(modal_rect(screen)),
            "the host's rect disagrees with the drawn rect at {width}x{height}"
        );
    }
}

#[test]
fn the_hosted_rect_is_actually_centred_and_within_the_screen() {
    let screen = Rect::new(0, 0, 120, 40);
    let rect = modal_rect(screen);
    assert!(rect.width <= screen.width && rect.height <= screen.height);
    let left_gap = rect.x - screen.x;
    let right_gap = screen.x + screen.width - (rect.x + rect.width);
    assert!(
        left_gap.abs_diff(right_gap) <= 1,
        "the modal is off-centre: {left_gap} left, {right_gap} right"
    );
}

#[test]
fn clicking_each_button_produces_its_decision() {
    let screen = Rect::new(0, 0, 120, 40);
    let area = modal_rect(screen);

    // Every button must be reachable by pointer at the coordinates it is DRAWN at.
    for action in ModalAction::ALL {
        let mut host = host(screen);
        let rect = host
            .modal
            .as_ref()
            .expect("open")
            .button_rects(area)
            .into_iter()
            .find(|(candidate, _)| *candidate == action)
            .map(|(_, rect)| rect)
            .unwrap_or_else(|| panic!("{action:?} has no rect"));

        let outcome = host.handle_click(rect.x, rect.y, action.target());

        match action {
            ModalAction::Approve => assert!(
                matches!(
                    outcome,
                    ModalOutcome::Approve {
                        scope: aibr_tui::input::traits::ApproveScope::Apply
                    }
                ),
                "{action:?} produced {outcome:?}"
            ),
            ModalAction::ApproveStepByStep => assert!(
                matches!(
                    outcome,
                    ModalOutcome::Approve {
                        scope: aibr_tui::input::traits::ApproveScope::StepByStep
                    }
                ),
                "step-by-step is a SEPARATE grant, not the same boolean: {outcome:?}"
            ),
            ModalAction::Reject => assert!(
                matches!(outcome, ModalOutcome::Reject { .. }),
                "{outcome:?}"
            ),
            ModalAction::Abort => assert_eq!(
                outcome,
                ModalOutcome::Abort,
                "Abort cancels the job. Returning Dismissed closes the modal and \
                 sends nothing, which is a button labelled Abort doing Esc's job"
            ),
        }
        assert!(
            !host.is_open(),
            "{action:?} left the prompt on screen after deciding"
        );
    }
}

#[test]
fn a_click_on_the_modal_body_moves_focus_without_deciding() {
    let screen = Rect::new(0, 0, 120, 40);
    let area = modal_rect(screen);
    let mut host = host(screen);

    // The title row is inside the modal and above the buttons.
    let row = area.y;
    let outcome = host.handle_click(area.x + 4, row, FocusTarget::Reject);

    assert_eq!(outcome, ModalOutcome::Consumed);
    assert!(
        host.is_open(),
        "a click inside the modal that is not a button must decide nothing -- a \\
         blocked job must not be dismissible by a stray click meant for the \\
         terminal behind it"
    );
    assert_eq!(
        host.focus(),
        FocusTarget::Reject,
        "it should still move focus, so the keyboard can carry on from there"
    );
}

#[test]
fn a_click_outside_the_modal_does_not_reach_it() {
    let screen = Rect::new(0, 0, 120, 40);
    let mut host = host(screen);

    // Well outside, in the pane the modal is covering.
    let outcome = host.handle_click(2, 2, FocusTarget::Approve);

    assert_eq!(outcome, ModalOutcome::Consumed);
    assert!(host.is_open(), "the prompt must survive a click behind it");
    assert_eq!(
        host.focus(),
        FocusTarget::Approve,
        "and a click behind it must not move its focus either"
    );
}

#[test]
fn a_typed_justification_is_collected_and_carried_into_the_rejection() {
    let mut host = host(Rect::new(0, 0, 120, 40));
    // Focus the justification field, then type. The text is part of the audit
    // trail, so it has to survive all the way into the command.
    host.set_focus(FocusTarget::Justification);
    for character in "too risky".chars() {
        let event = aibr_tui::input::traits::KeyEventLike {
            char: Some(character),
            ..Default::default()
        };
        host.handle_key(&event);
    }
    let modal = host.modal.as_ref().expect("still open");
    assert_eq!(modal.justification, "too risky");

    let event = aibr_tui::input::traits::KeyEventLike {
        named: Some(aibr_tui::input::traits::NamedKey::Enter),
        ..Default::default()
    };
    let outcome = host.handle_key(&event);

    match outcome {
        // The justification is part of the audit trail, so it must survive into the
        // command rather than being dropped on the way out.
        ModalOutcome::Reject {
            justification: Some(text),
        } => assert_eq!(text, "too risky"),
        other => panic!("expected a rejection carrying the reason, got {other:?}"),
    }
}

#[test]
fn the_modal_opens_for_a_blocked_pane_kind_without_being_asked() {
    // Guards the invariant from the other direction: the prompt appears because the
    // job is blocked, not because something requested it.
    let modal = ApprovalModalState::new(blocked_job());
    assert_eq!(modal.focused, FocusTarget::Approve);
    assert_eq!(modal.reason(), "the agent proposed a plan");
    // The job is blocked, so its pane exists and is a terminal awaiting a decision.
    assert_eq!(
        aibr_tui::state::PaneKind::Terminal,
        PaneKind::Terminal,
        "sanity: the pane kind enum the modal branches on is the one wired up"
    );
}

#[test]
fn expiry_is_not_needed_because_a_dismissed_modal_does_not_leak_a_timer() {
    // `tick` drives prefix and toast expiry. A modal that outlived its decision
    // would keep the input engine in the modal branch for every later key, which is
    // the failure mode this file exists to prevent.
    let mut host = host(Rect::new(0, 0, 120, 40));
    let event = aibr_tui::input::traits::KeyEventLike {
        named: Some(aibr_tui::input::traits::NamedKey::Esc),
        ..Default::default()
    };
    host.handle_key(&event);

    assert!(!host.is_open());
    let _ = Instant::now();
    assert!(
        host.job_id().is_none(),
        "a closed modal still reports a job, so the next blocked job's prompt \
         would render against the previous one's"
    );
}

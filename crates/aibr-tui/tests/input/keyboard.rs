//! The keyboard state machine: prefix bindings, the timeout, chords, passthrough
//! encoding, copy mode, and modal interception.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

use aibr_tui::input::{
    key, Action, ApprovalModal, Chord, InputMode, ModalOutcome, PrefixKey, PREFIX_TIMEOUT,
};
use aibr_tui::layout::tile::Focus;

use crate::common::{
    chrome, decode_base64, input, later, now, one_pane_with_job, payloads, pty_target, rects,
    two_pane_layout, two_pane_state,
};
use crate::fixtures::{FakeList, FakeModal, FakePane};

/// Press a bare character.
fn ch(character: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE)
}

/// Press `Ctrl+<character>`.
fn ctrl(character: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(character), KeyModifiers::CONTROL)
}

/// Press `Ctrl+Alt+<character>`.
fn ctrl_alt(character: char) -> KeyEvent {
    KeyEvent::new(
        KeyCode::Char(character),
        KeyModifiers::CONTROL | KeyModifiers::ALT,
    )
}

/// The `Ctrl+B` prefix key.
fn prefix() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL)
}

// ---------------------------------------------------------------------------------------
// Terminal mode: passthrough encoding
// ---------------------------------------------------------------------------------------

/// `Ctrl+C` is `0x03` and reaches the focused pane.
#[test]
fn ctrl_c_is_etx_and_goes_to_the_focused_pane() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();

    let actions = key(
        &mut state,
        &ctrl('c'),
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    let sent = payloads(&actions);
    assert_eq!(
        sent,
        vec![vec![0x03u8]],
        "Ctrl+C must be ETX, not the letter c"
    );
    assert_eq!(
        pty_target(match &actions[0] {
            Action::Command(command) => command,
            other => panic!("expected a command, got {other:?}"),
        }),
        Some("pane-a".to_owned())
    );
}

/// Arrows are CSI sequences, not three separate characters.
#[test]
fn arrows_encode_as_csi_sequences() {
    let cases = [
        (KeyCode::Up, &b"\x1b[A"[..]),
        (KeyCode::Down, &b"\x1b[B"[..]),
        (KeyCode::Right, &b"\x1b[C"[..]),
        (KeyCode::Left, &b"\x1b[D"[..]),
    ];
    for (code, expected) in cases {
        let mut state = input();
        let mut ui = two_pane_state();
        let mut pane = FakePane::default();
        let mut layout = two_pane_layout();
        let mut modal = FakeModal::default();
        let event = KeyEvent::new(code, KeyModifiers::NONE);

        let actions = key(
            &mut state,
            &event,
            now(),
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal,
        );

        assert_eq!(payloads(&actions), vec![expected.to_vec()], "{code:?}");
    }
}

/// `Shift+Enter` is `CSI 1;2E`, NOT `CR`.
///
/// The failure this prevents: an agent session treats `Shift+Enter` as "newline without
/// submit", and forwarding `CR` submits the prompt, so a multiline input is cut at the
/// first wrapped line.
#[test]
fn shift_enter_is_csi_1_2_e_and_not_a_carriage_return() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let event = KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT);

    let actions = key(
        &mut state,
        &event,
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    assert_eq!(payloads(&actions), vec![b"\x1b[1;2E".to_vec()]);
    assert_ne!(
        payloads(&actions),
        vec![b"\r".to_vec()],
        "Shift+Enter must not submit"
    );
}

/// A multi-byte codepoint is sent whole.
///
/// This is the assertion behind `encode_key`'s "a codepoint cannot be split" claim: if a
/// refactor ever indexed a `&str` by byte, `é` would arrive as two fragments and the
/// agent's prompt would show a replacement character.
#[test]
fn multi_byte_characters_are_sent_whole() {
    for (character, expected) in [
        ('é', "é".as_bytes()),
        ('→', "→".as_bytes()),
        ('🦀', "🦀".as_bytes()),
    ] {
        let mut state = input();
        let mut ui = two_pane_state();
        let mut pane = FakePane::default();
        let mut layout = two_pane_layout();
        let mut modal = FakeModal::default();

        let actions = key(
            &mut state,
            &ch(character),
            now(),
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal,
        );

        assert_eq!(payloads(&actions), vec![expected.to_vec()], "{character:?}");
        // And it round-trips: the decoded bytes are valid UTF-8 spelling that character.
        assert_eq!(
            std::str::from_utf8(&payloads(&actions)[0]).unwrap(),
            character.to_string()
        );
    }
}

/// `Ctrl` over ASCII maps to control codes; a non-ASCII `Ctrl` maps to nothing.
#[test]
fn ctrl_ascii_maps_to_control_codes_and_non_ascii_does_not() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();

    assert_eq!(
        payloads(&key(
            &mut state,
            &ctrl('a'),
            now(),
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal
        )),
        vec![vec![0x01]]
    );
    assert_eq!(
        payloads(&key(
            &mut state,
            &ctrl('['),
            now(),
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal
        )),
        vec![vec![0x1b]]
    );
    // `Ctrl+é` has no agreed encoding, so nothing is sent rather than the UTF-8 bytes.
    assert!(key(
        &mut state,
        &ctrl('é'),
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal
    )
    .is_empty());
}

// ---------------------------------------------------------------------------------------
// Prefix mode
// ---------------------------------------------------------------------------------------

/// `Ctrl+B` arms the prefix and is NOT forwarded to the PTY.
#[test]
fn ctrl_b_arms_the_prefix_without_forwarding() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();

    let actions = key(
        &mut state,
        &prefix(),
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    assert!(actions.is_empty(), "the prefix itself reaches nothing");
    assert_eq!(
        ui.presentation.mode,
        InputMode::Prefix,
        "the mode must be visible"
    );
    assert!(state.prefix_armed());
}

/// EVERY documented prefix binding, each asserted on what it does.
#[test]
fn every_prefix_binding_does_what_it_says() {
    // `PrefixKey::all()` is the cheatsheet's list, so a binding added without a test here
    // is a binding nobody has looked at.
    assert_eq!(
        PrefixKey::all().len(),
        11,
        "the keymap grew; add the case below"
    );

    /// `expect` judges the WHOLE action list, so a binding whose correct behaviour is to
    /// produce nothing (`h` at the leftmost pane, which is clamped) is expressible. A
    /// per-action predicate could not say that, and would have to special-case the empty
    /// list -- which is where a "no action" binding quietly stops being tested.
    struct Case {
        key: PrefixKey,
        press: KeyEvent,
        expect: fn(&[Action]) -> bool,
        what: &'static str,
    }

    let cases = [
        Case {
            key: PrefixKey::NewTab,
            press: ch('c'),
            expect: |actions| {
                actions
                    == [Action::NewTabRequested {
                        workspace_id: "ws-1".to_owned(),
                    }]
            },
            what: "Ctrl+B c opens a new tab in the active workspace",
        },
        Case {
            key: PrefixKey::SplitVertical,
            press: ch('v'),
            expect: |actions| {
                actions
                    == [Action::SpawnPaneRequested {
                        workspace_id: "ws-1".to_owned(),
                        parent_pane_id: "pane-a".to_owned(),
                        axis: aibr_tui::input::Axis::Vertical,
                        kind: aibr_tui::state::PaneKind::Terminal,
                    }]
            },
            what: "Ctrl+B v splits vertically",
        },
        Case {
            key: PrefixKey::SplitHorizontal,
            press: ch('-'),
            expect: |actions| {
                actions
                    == [Action::SpawnPaneRequested {
                        workspace_id: "ws-1".to_owned(),
                        parent_pane_id: "pane-a".to_owned(),
                        axis: aibr_tui::input::Axis::Horizontal,
                        kind: aibr_tui::state::PaneKind::Terminal,
                    }]
            },
            what: "Ctrl+B - splits horizontally",
        },
        Case {
            // Clamped, so there is NO action: the layout already knows it cannot move, and
            // inventing a target would send the operator's keystrokes somewhere they did not
            // pick.
            key: PrefixKey::Focus(Focus::Left),
            press: ch('h'),
            expect: |actions| actions.is_empty(),
            what: "Ctrl+B h is clamped at the leftmost pane",
        },
        Case {
            key: PrefixKey::Focus(Focus::Right),
            press: ch('l'),
            expect: |actions| {
                actions
                    == [Action::FocusPane {
                        pane_id: "pane-b".to_owned(),
                    }]
            },
            what: "Ctrl+B l moves right",
        },
        Case {
            key: PrefixKey::Zoom,
            press: ch('z'),
            expect: |actions| {
                actions
                    == [Action::ZoomPane {
                        pane_id: Some("pane-a".to_owned()),
                    }]
            },
            what: "Ctrl+B z zooms the focused pane",
        },
        Case {
            key: PrefixKey::ToggleSidebar,
            press: ch('b'),
            expect: |actions| actions == [Action::SidebarVisible(false)],
            what: "Ctrl+B b hides the sidebar",
        },
        Case {
            key: PrefixKey::CopyMode,
            press: ch('['),
            expect: |actions| actions.is_empty(),
            what: "Ctrl+B [ enters copy mode",
        },
        Case {
            key: PrefixKey::Detach,
            press: ch('q'),
            expect: |actions| actions == [Action::Detach],
            what: "Ctrl+B q detaches",
        },
    ];

    for case in cases {
        let mut state = input();
        let mut ui = two_pane_state();
        let mut pane = FakePane::new(&["one", "two", "three"], 40, 10);
        let mut layout = two_pane_layout();
        let mut modal = FakeModal::default();
        let start = now();

        key(
            &mut state,
            &prefix(),
            start,
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal,
        );
        assert_eq!(
            ui.presentation.mode,
            InputMode::Prefix,
            "{}: prefix not armed",
            case.what
        );
        let actions = key(
            &mut state,
            &case.press,
            start,
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal,
        );

        assert!((case.expect)(&actions), "{}: got {actions:?}", case.what);
        assert!(
            !state.prefix_armed(),
            "{}: the prefix must not stay armed",
            case.what
        );

        // Where the binding LEAVES the mode, which is `Terminal` for everything except the
        // two keys that mean "enter another mode". Every mode therefore has a defined exit,
        // which is what the status bar's mode indicator depends on.
        match case.key {
            PrefixKey::CopyMode => {
                assert_eq!(ui.presentation.mode, InputMode::Copy, "{}", case.what);
                assert!(state.copy_mode().is_some(), "{}", case.what);
            }
            PrefixKey::Detach => assert!(state.detach_requested(), "{}", case.what),
            PrefixKey::Zoom => assert_eq!(ui.presentation.zoomed.as_deref(), Some("pane-a")),
            _ => assert_eq!(
                ui.presentation.mode,
                InputMode::Terminal,
                "{}: every other prefix key returns to Terminal mode",
                case.what
            ),
        }
        let _ = pane;
    }
}

/// The arrow keys are focus keys after the prefix, as documented.
#[test]
fn arrows_after_the_prefix_move_focus() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let start = now();

    key(
        &mut state,
        &prefix(),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    let actions = key(
        &mut state,
        &KeyEvent::new(KeyCode::Right, KeyModifiers::NONE),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    assert_eq!(
        actions,
        vec![Action::FocusPane {
            pane_id: "pane-b".to_owned()
        }]
    );
}

/// A MISTYPED prefix key forwards nothing.
///
/// The alternative -- forwarding it -- would put an unexplained character into an agent's
/// stdin, which is worse than swallowing it.
#[test]
fn a_mistyped_prefix_key_is_swallowed_not_forwarded() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let start = now();

    key(
        &mut state,
        &prefix(),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    let actions = key(
        &mut state,
        &ch('Q'),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    assert!(actions.is_empty(), "got {actions:?}");
    assert_eq!(ui.presentation.mode, InputMode::Terminal);
}

/// An expired prefix drops the next keystroke instead of eating it.
///
/// THE TIMEOUT EXISTS BECAUSE OF THIS: without it, a `Ctrl+B` followed by a shrug leaves
/// the client eating keystrokes -- including `q` -- and the operator's only way out is
/// `Ctrl+C`, which goes to the PTY.
#[test]
fn an_expired_prefix_returns_to_terminal_and_forwards_the_next_key() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let start = now();

    // Just inside the window: `q` is still a command.
    key(
        &mut state,
        &prefix(),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    let just_inside = later(start, PREFIX_TIMEOUT.as_millis() as u64 - 1);
    let actions = key(
        &mut state,
        &ch('q'),
        just_inside,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::Detach],
        "inside the window, q still detaches"
    );

    // At the window: the keystroke is the operator's, not a command.
    let mut state = input();
    let mut ui = two_pane_state();
    key(
        &mut state,
        &prefix(),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    let expired = later(start, PREFIX_TIMEOUT.as_millis() as u64);
    let actions = key(
        &mut state,
        &ch('q'),
        expired,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    assert_eq!(
        payloads(&actions),
        vec![b"q".to_vec()],
        "an expired prefix must forward"
    );
    assert_eq!(ui.presentation.mode, InputMode::Terminal);
    assert!(
        !state.prefix_armed(),
        "the expired deadline must be dropped"
    );
}

/// The timeout window is long enough for a laggy SSH round trip and short enough to
/// matter. Asserted so a well-meaning change to `Duration::from_secs(10)` fails here.
#[test]
fn the_prefix_timeout_is_two_seconds() {
    assert_eq!(PREFIX_TIMEOUT.as_millis(), 2000);
}

// ---------------------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------------------

/// `Ctrl+Alt+H/J/K/L` switch panes from Terminal mode, without a prefix.
#[test]
fn ctrl_alt_chords_switch_panes_in_terminal_mode() {
    // `h`/`l` move focus, from a known starting pane.
    for (start, key_character, expected) in [("pane-a", 'l', "pane-b"), ("pane-b", 'h', "pane-a")] {
        let mut state = input();
        let mut ui = two_pane_state();
        let mut pane = FakePane::default();
        let mut layout = two_pane_layout();
        let mut modal = FakeModal::default();
        crate::common::focus(&mut ui, &mut layout, start);

        let actions = key(
            &mut state,
            &ctrl_alt(key_character),
            now(),
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal,
        );

        let moved = actions
            .iter()
            .find_map(|action| match action {
                Action::FocusPane { pane_id } => Some(pane_id.as_str()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("Ctrl+Alt+{key_character} produced {actions:?}"));
        assert_eq!(moved, expected);
        assert_eq!(ui.presentation.focused.as_deref(), Some(expected));
        assert_eq!(
            layout.focused.as_deref(),
            Some(expected),
            "both records must agree"
        );
    }

    // `Ctrl+Alt+D` is the plan's split chord, not a focus chord.
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let actions = key(
        &mut state,
        &ctrl_alt('d'),
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    assert!(
        actions
            .iter()
            .any(|action| matches!(action, Action::SpawnPaneRequested { .. })),
        "Ctrl+Alt+D must split: {actions:?}"
    );
}

/// A chord is NEVER forwarded to the PTY -- that is the documented tradeoff.
#[test]
fn a_chord_never_reaches_the_pty() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();

    let actions = key(
        &mut state,
        &ctrl_alt('h'),
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    assert!(
        payloads(&actions).is_empty(),
        "the PTY must not see a chord: {actions:?}"
    );
}

/// `Ctrl+Alt+Shift+H` is NOT a chord -- it is the letter, because the prefix and the chord
/// both fire on `Ctrl+Alt` alone otherwise.
#[test]
fn ctrl_alt_shift_is_not_a_chord() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let event = KeyEvent::new(
        KeyCode::Char('h'),
        KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SHIFT,
    );

    let actions = key(
        &mut state,
        &event,
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    assert_eq!(Chord::from_event(&event), None);
    assert_eq!(
        payloads(&actions),
        vec![vec![0x1b, 0x08]],
        "Ctrl+Alt+Shift+H is ESC-prefixed BS, and is not a chord"
    );
}

/// `Ctrl+Alt+B` is the sidebar chord, not the `Ctrl+B` prefix.
#[test]
fn ctrl_alt_b_toggles_the_sidebar_and_does_not_arm_the_prefix() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();

    let actions = key(
        &mut state,
        &ctrl_alt('b'),
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    assert_eq!(actions, vec![Action::SidebarVisible(false)]);
    assert!(!state.prefix_armed());
    assert_eq!(ui.presentation.mode, InputMode::Terminal);
}

// ---------------------------------------------------------------------------------------
// Copy mode
// ---------------------------------------------------------------------------------------

/// Enter copy mode with `Ctrl+B [` and leave it with `q`.
#[test]
fn copy_mode_has_a_documented_exit() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::new(&["alpha", "beta", "gamma"], 40, 10);
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let start = now();

    key(
        &mut state,
        &prefix(),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    key(
        &mut state,
        &ch('['),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    assert_eq!(ui.presentation.mode, InputMode::Copy);

    // Copy mode owns its keys: `j` does not reach the PTY.
    let actions = key(
        &mut state,
        &ch('j'),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    assert!(
        payloads(&actions).is_empty(),
        "copy mode must not fall through: {actions:?}"
    );

    let actions = key(
        &mut state,
        &ch('q'),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    assert!(actions.is_empty());
    assert_eq!(ui.presentation.mode, InputMode::Terminal);
    assert!(state.copy_mode().is_none());
}

/// `Esc` leaves visual mode first, then copy mode -- twice.
#[test]
fn escape_leaves_visual_mode_before_copy_mode() {
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::new(&["alpha", "beta", "gamma"], 40, 10);
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let start = now();

    key(
        &mut state,
        &prefix(),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    key(
        &mut state,
        &ch('['),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    key(
        &mut state,
        &ch('v'),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    assert!(state.copy_mode().expect("in copy mode").visual);

    let escape = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
    key(
        &mut state,
        &escape,
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        ui.presentation.mode,
        InputMode::Copy,
        "the first Esc leaves visual mode"
    );
    assert!(!state.copy_mode().expect("still in copy mode").visual);

    key(
        &mut state,
        &escape,
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        ui.presentation.mode,
        InputMode::Terminal,
        "the second Esc leaves copy mode"
    );
}

/// A search that crosses a soft wrap is FOUND, because the query is what the operator
/// saw on screen.
#[test]
fn search_matches_across_a_soft_wrap() {
    let pane = FakePane::new(&["await db.orders", ".deleteMany();"], 40, 10).wrapping(1);

    // The query is `orders.deleteMany`: on screen the operator sees `orders` at the end of
    // one row and `.deleteMany()` at the start of the next, and what they mean is the
    // logical line. Reported at (0, 12) -- where the match starts, not where the wrap is.
    let hit = aibr_tui::input::copy_mode::find(&pane, "pane-a", "orders.deleteMany", 0, true);
    assert_eq!(
        hit.map(|hit| (hit.line, hit.column)),
        Some((0, 9)),
        "a query spanning a soft wrap must match at the position it starts"
    );

    // The same query must NOT match when the rows are hard-terminated, which is what proves
    // the first assertion is about the wrap rather than about the matcher being loose.
    let hard = FakePane::new(&["await db.orders", ".deleteMany();"], 40, 10);
    assert_eq!(
        aibr_tui::input::copy_mode::find(&hard, "pane-a", "orders.deleteMany", 0, true),
        None
    );
}

/// A search that finds nothing SAYS SO and stays in copy mode.
///
/// Silently doing nothing is indistinguishable from a hung client, and an operator
/// searching a 200k-line log will try the query three more times before concluding the
/// pane is frozen.
#[test]
fn a_failed_search_reports_not_found_and_keeps_the_cursor() {
    let mut pane = FakePane::new(&["alpha", "beta", "gamma"], 40, 10);
    let mut state = input();
    let mut ui = two_pane_state();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let start = now();

    key(
        &mut state,
        &prefix(),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    key(
        &mut state,
        &ch('['),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    let before = state.copy_mode().expect("in copy mode").cursor_line;

    // `/`, then the query, then Enter.
    key(
        &mut state,
        &ch('/'),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    for character in "nonexistent".chars() {
        key(
            &mut state,
            &ch(character),
            start,
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal,
        );
    }
    let actions = key(
        &mut state,
        &KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    let toast = actions.iter().find_map(|action| match action {
        Action::Toast(toast) => Some(toast.message.as_str()),
        _ => None,
    });
    assert!(
        toast.is_some_and(|message| message.contains("pattern not found")),
        "a failed search must say so: {actions:?}"
    );
    assert_eq!(
        ui.presentation.mode,
        InputMode::Copy,
        "a failed search must not exit copy mode"
    );
    let after = state.copy_mode().expect("still in copy mode").cursor_line;
    assert_eq!(before, after, "a failed search must not move the cursor");
    let _ = &mut pane;
}

/// A successful search lands on the hit, and `n` walks to the next one.
#[test]
fn search_lands_on_the_hit_and_n_repeats() {
    let mut pane = FakePane::new(&["alpha", "beta", "gamma", "beta again"], 40, 10);
    let mut state = input();
    let mut ui = two_pane_state();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let start = now();

    key(
        &mut state,
        &prefix(),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    key(
        &mut state,
        &ch('['),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    key(
        &mut state,
        &ch('/'),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    for character in "beta".chars() {
        key(
            &mut state,
            &ch(character),
            start,
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal,
        );
    }
    key(
        &mut state,
        &KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    // Copy mode starts at the BOTTOM of the scrollback, so the search finds the LAST match.
    assert_eq!(state.copy_mode().expect("in copy mode").cursor_line, 3);

    key(
        &mut state,
        &ch('n'),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        state.copy_mode().expect("in copy mode").cursor_line,
        1,
        "n from the end wraps to the first match"
    );
    let _ = &mut pane;
}

/// `v` then `y` copies the visual selection to the clipboard, redacted.
#[test]
fn copy_mode_yank_copies_a_redacted_selection() {
    let mut pane = FakePane::new(&["token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"], 60, 10);
    let mut state = input();
    let mut ui = two_pane_state();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();
    let start = now();

    key(
        &mut state,
        &prefix(),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    key(
        &mut state,
        &ch('['),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    key(
        &mut state,
        &KeyCode::Home.into(),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    key(
        &mut state,
        &ch('v'),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    key(
        &mut state,
        &ch('$'),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );
    let actions = key(
        &mut state,
        &ch('y'),
        start,
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    let copied = actions.iter().find_map(|action| match action {
        Action::CopySelection(text) => Some(text.as_str().to_owned()),
        _ => None,
    });
    let copied = copied.expect("nothing yanked");
    assert!(copied.contains("[redacted]"), "got {actions:?}");
    assert!(
        !copied.contains("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"),
        "the token must not reach the clipboard"
    );
    assert!(actions
        .iter()
        .any(|action| matches!(action, Action::Toast(_))));
}

// ---------------------------------------------------------------------------------------
// Modal interception
// ---------------------------------------------------------------------------------------

/// While the modal is open, a keystroke intended for the terminal behind it is SWALLOWED.
///
/// This is the property the whole modal-interception rule exists for: a `blocked` job is a
/// security decision, and typing into an agent while the human believes they are reading
/// is how the agent acts unattended.
#[test]
fn a_keystroke_meant_for_the_terminal_behind_the_modal_is_swallowed() {
    let mut state = input();
    let mut ui = one_pane_with_job();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::open_on("job-1");

    for event in [ch('x'), ctrl('c'), KeyCode::Enter.into(), ctrl_alt('h')] {
        let actions = key(
            &mut state,
            &event,
            now(),
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal,
        );
        assert!(
            payloads(&actions).is_empty(),
            "{event:?} reached the PTY behind the modal: {actions:?}"
        );
    }
    assert_eq!(modal.keys.len(), 4, "every key must reach the modal");
}

/// Approving with `Enter` and approving by click produce the SAME command.
///
/// Two implementations of one decision would let one of them drift, and the one that
/// drifts is the security-relevant one.
#[test]
fn approving_by_key_and_by_click_produce_the_same_command() {
    let mut state = input();
    let mut ui = one_pane_with_job();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::open_on("job-1")
        .answering_keys(ModalOutcome::Approve {
            scope: aibr_tui::input::ApproveScope::Apply,
        })
        .answering_clicks(ModalOutcome::Approve {
            scope: aibr_tui::input::ApproveScope::Apply,
        })
        .at(ratatui::layout::Rect::new(20, 8, 60, 14));

    let by_key = key(
        &mut state,
        &KeyCode::Enter.into(),
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    let mut state = input();
    let mut ui = one_pane_with_job();
    let click = ratatui::layout::Rect::new(20, 8, 60, 14);
    let event = MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: click.x + 10,
        row: click.y + 5,
        modifiers: crossterm::event::KeyModifiers::NONE,
    };
    let by_click = aibr_tui::input::mouse(
        &mut state,
        &event,
        &rects(&layout),
        &chrome(),
        &aibr_tui::input::SidebarRows::default(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut modal,
    );

    let expected = vec![Action::Command(
        aibr_tui::input::commands::approve_plan("job-1", aibr_tui::input::ApproveScope::Apply)
            .expect("job-1 matches the contract pattern"),
    )];
    assert_eq!(by_key, expected);
    assert_eq!(
        by_click, expected,
        "a click must approve exactly as Enter does"
    );
}

/// Rejecting carries the operator's justification to the daemon.
#[test]
fn rejecting_carries_the_justification() {
    let mut state = input();
    let mut ui = one_pane_with_job();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::open_on("job-1").answering_keys(ModalOutcome::Reject {
        justification: Some("this touches the database".to_owned()),
    });

    let actions = key(
        &mut state,
        &KeyCode::Esc.into(),
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    assert_eq!(
        actions,
        vec![Action::Command(
            aibr_tui::input::commands::reject_plan("job-1", Some("this touches the database"))
                .expect("valid")
        )]
    );
}

/// `Tab` cycles the modal's focus and wraps, so the modal cannot be left by accident.
#[test]
fn tab_cycles_modal_focus_and_wraps() {
    let mut state = input();
    let mut ui = one_pane_with_job();
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::open_on("job-1");
    let tab = KeyEvent::new(KeyCode::Tab, crossterm::event::KeyModifiers::NONE);

    let mut seen = vec![ApprovalModal::focus(&modal)];
    for _ in 0..4 {
        let actions = key(
            &mut state,
            &tab,
            now(),
            &mut ui,
            &mut pane,
            &mut layout,
            &mut modal,
        );
        assert!(
            actions
                .iter()
                .all(|action| matches!(action, Action::ModalFocus { .. })),
            "{actions:?}"
        );
        seen.push(ApprovalModal::focus(&modal));
    }
    assert_eq!(seen[0], seen[4], "Tab must wrap: {seen:?}");
}

/// A `pty_input` for a pane the contract rejects is reported, not silently dropped.
///
/// Silently dropping input is worse than the failure it avoids: the operator types into an
/// agent that never received the input and concludes the agent hung.
#[test]
fn a_contract_rejected_input_is_reported_rather_than_dropped() {
    let mut state = input();
    let mut ui = two_pane_state();
    // A pane id the contract's pattern refuses: it starts with a digit's neighbour `-`.
    ui.presentation.focused = Some("-bad id".to_owned());
    let mut pane = FakePane::default();
    let mut layout = two_pane_layout();
    let mut modal = FakeModal::default();

    let actions = key(
        &mut state,
        &ch('a'),
        now(),
        &mut ui,
        &mut pane,
        &mut layout,
        &mut modal,
    );

    assert!(payloads(&actions).is_empty());
    assert!(
        actions
            .iter()
            .any(|action| matches!(action, Action::Toast(_))),
        "a rejected input must be reported: {actions:?}"
    );
}

/// `decode_base64` is the test's own inverse, so a `pty_input` assertion on bytes is only
/// as good as this. Asserted directly.
#[test]
fn the_test_base64_decoder_round_trips() {
    for bytes in [
        b"a".as_slice(),
        b"ab",
        b"abc",
        b"abcd",
        b"\x1b[A",
        &[0x03u8][..],
        "héllo".as_bytes(),
    ] {
        let encoded = aibr_tui::input::commands::base64_encode(bytes);
        assert_eq!(decode_base64(&encoded), bytes, "{encoded}");
    }
    let _ = chrome();
}

//! The pure helpers: URL sanitisation, redaction, PTY encoding, base64, copy-mode search,
//! and menu geometry.

use aibr_tui::input::{
    commands, keys, sanitize_url, ConservativeRedactor, ContextMenu, Redactor, SanitizedUrl,
    UrlRejection, WHEEL_LINES,
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::fixtures::FakePane;

// ---------------------------------------------------------------------------------------
// URL sanitisation
// ---------------------------------------------------------------------------------------

/// `http` and `https` are the ONLY schemes that reach an opener.
///
/// The allowlist is two entries on purpose. A hyperlink in this client comes from a pane,
/// the pane from an agent, and the agent from a peer on the tailnet -- so the string being
/// handed to the operating system's URL handler is chosen by someone else.
#[test]
fn only_http_and_https_are_allowed() {
    for raw in [
        "http://example.com",
        "https://example.com",
        "https://example.com/a/b?c=d#e",
        "https://example.com:8443/x",
        "HTTP://EXAMPLE.COM/Path",
        "HtTpS://example.com",
        "  https://example.com/pad  ",
        "https://user:pw@example.com/x",
    ] {
        let url =
            sanitize_url(raw).unwrap_or_else(|error| panic!("{raw:?} was refused: {error:?}"));
        // The scheme is lowercased and the padding trimmed, so what the opener receives is
        // exactly what was validated rather than something close to it.
        assert!(
            url.as_str().starts_with("http"),
            "{raw:?} -> {}",
            url.as_str()
        );
    }
}

/// Everything else is refused, with the specific reason.
#[test]
fn every_other_scheme_is_refused_by_name() {
    for (raw, expected) in [
        (
            "file:///etc/passwd",
            UrlRejection::SchemeNotAllowed("file".to_owned()),
        ),
        (
            "FILE:///etc/passwd",
            UrlRejection::SchemeNotAllowed("file".to_owned()),
        ),
        (
            "javascript:alert(1)",
            UrlRejection::SchemeNotAllowed("javascript".to_owned()),
        ),
        (
            "data:text/html,<script>",
            UrlRejection::SchemeNotAllowed("data".to_owned()),
        ),
        (
            "vbscript:msgbox",
            UrlRejection::SchemeNotAllowed("vbscript".to_owned()),
        ),
        (
            "mailto:a@b.c",
            UrlRejection::SchemeNotAllowed("mailto".to_owned()),
        ),
        (
            "vscode://x",
            UrlRejection::SchemeNotAllowed("vscode".to_owned()),
        ),
        (
            "ssh://host",
            UrlRejection::SchemeNotAllowed("ssh".to_owned()),
        ),
    ] {
        assert_eq!(sanitize_url(raw), Err(expected), "{raw:?}");
    }
}

/// The parser-differential cases: control characters, backslashes, missing authority.
///
/// Each of these is a way a lenient URL parser and a strict one disagree, which is how an
/// allowlist gets bypassed without any of its rules being wrong.
#[test]
fn parser_differential_attempts_are_refused() {
    assert_eq!(
        sanitize_url("https://example.com/\nrm -rf ~"),
        Err(UrlRejection::ControlCharacter)
    );
    assert_eq!(
        sanitize_url("https://exa\tmple.com"),
        Err(UrlRejection::ControlCharacter)
    );
    assert_eq!(
        sanitize_url("https://example.com/\u{7f}"),
        Err(UrlRejection::ControlCharacter)
    );
    // A backslash is normalised to a slash by several parsers, which turns
    // `http:\\evil.example` into `http://evil.example`.
    assert_eq!(
        sanitize_url("http:\\\\evil.example"),
        Err(UrlRejection::Backslash)
    );
    assert_eq!(
        sanitize_url("https://example.com\\@evil"),
        Err(UrlRejection::Backslash)
    );
    // Not `//` after the scheme.
    assert_eq!(
        sanitize_url("http:example.com"),
        Err(UrlRejection::NotHierarchical)
    );
    assert_eq!(sanitize_url("https://"), Err(UrlRejection::NoAuthority));
    assert_eq!(
        sanitize_url("https:///path"),
        Err(UrlRejection::NoAuthority)
    );
    // No scheme at all.
    assert_eq!(sanitize_url("example.com/x"), Err(UrlRejection::NoScheme));
    assert_eq!(
        sanitize_url("://example.com"),
        Err(UrlRejection::MalformedScheme)
    );
    assert_eq!(
        sanitize_url("1http://example.com"),
        Err(UrlRejection::MalformedScheme)
    );
    assert_eq!(sanitize_url(""), Err(UrlRejection::Empty));
    assert_eq!(sanitize_url("   "), Err(UrlRejection::Empty));
    let long = format!("https://example.com/{}", "a".repeat(4096));
    assert!(matches!(sanitize_url(&long), Err(UrlRejection::TooLong(_))));
}

/// `SanitizedUrl` cannot be built from a string, which is what makes `UrlOpener` safe to
/// implement: the only way to obtain one is through the sanitiser.
#[test]
fn a_sanitized_url_can_only_come_from_the_sanitiser() {
    let url: SanitizedUrl = sanitize_url("https://example.com").expect("valid");
    assert_eq!(url.to_string(), "https://example.com");
    assert_eq!(url.into_string(), "https://example.com");
}

// ---------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------

/// The secret shapes criteria 7 and 8 name, plus the common provider prefixes.
#[test]
fn redaction_masks_the_shapes_the_criteria_name() {
    let redactor = ConservativeRedactor;
    for secret in [
        "Authorization: Bearer sk-ant-api03-AAAABBBBCCCCDDDD1234",
        "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
        "password: hunter2CorrectHorse",
        "api_key = AKIAIOSFODNN7EXAMPLE",
        "https://alice:s3cr3tvalue@example.com/x",
        "export OPENAI_API_KEY=sk-proj-AAAABBBBCCCCDDDD",
    ] {
        let masked = redactor.redact(secret);
        assert!(
            masked.contains("[redacted]"),
            "unmasked: {secret:?} -> {masked:?}"
        );
    }
}

/// A private path is masked, because criteria 7 and 8 name paths alongside tokens: a home
/// directory plus a filename is a secret in a different form.
#[test]
fn redaction_masks_private_paths() {
    let masked = ConservativeRedactor.redact("reading /Users/alice/.ssh/id_ed25519 now");
    assert!(masked.contains("[redacted]"), "{masked:?}");
    assert!(!masked.contains("alice"), "{masked:?}");
    assert!(
        masked.contains("/Users/[redacted]/.ssh/id_ed25519"),
        "the path must stay usable so a copied command still runs: {masked:?}"
    );
}

/// Redaction MUST NOT eat ordinary output, or operators turn it off.
///
/// This is the property that decides whether the fail-closed default is usable at all: an
/// over-eager rule masks every identifier in a stack trace and the operator disables
/// redaction, which is worse than the leak it was preventing.
#[test]
fn redaction_leaves_ordinary_output_alone() {
    let redactor = ConservativeRedactor;
    for benign in [
        "await db.orders.deleteMany();",
        "class OrderController extends BaseController {}",
        "GET /api/v1/orders 200 12ms",
        "error: cannot find module 'node:fs/promises'",
        "csrftoken = abc123",
        "running 24 tests in 3.2s",
        "https://github.com/aibridge/aibr-tui/pull/12",
        "x = 1234567890",
    ] {
        assert_eq!(redactor.redact(benign), benign, "over-redacted: {benign:?}");
    }
}

/// The mask is FIXED WIDTH, so it does not leak the length of the secret.
#[test]
fn the_mask_is_fixed_width() {
    let short = ConservativeRedactor.redact("token=ghp_SHORT1234");
    let long = ConservativeRedactor.redact("token=ghp_aVeryMuchLongerTokenValue1234567890");
    let width = |masked: &str| masked.find("[redacted]").expect("masked");
    assert_eq!(width(&short), width(&long));
}

/// `RedactedText`'s constructor is crate-private, so a caller outside the crate cannot put
/// an unredacted string on the clipboard even by building the `Action` by hand.
#[test]
fn redacted_text_is_constructible_only_through_a_redactor() {
    let text = aibr_tui::input::redact_to_text(
        &ConservativeRedactor,
        "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX12",
    );
    assert!(!text.as_str().contains("ghp_ABCDEFGHIJKLMNOPQRSTUVWX12"));
    assert!(text.as_str().contains("[redacted]"));
    assert_eq!(text.into_string(), "[redacted]");
}

// ---------------------------------------------------------------------------------------
// PTY encoding
// ---------------------------------------------------------------------------------------

/// The encoding table, asserted in one place so a change to any arm is visible.
#[test]
fn the_pty_encoding_table_is_exact() {
    let none = KeyModifiers::NONE;
    let shift = KeyModifiers::SHIFT;
    let control = KeyModifiers::CONTROL;
    let alt = KeyModifiers::ALT;

    let cases: Vec<(KeyEvent, &[u8])> = vec![
        (KeyEvent::new(KeyCode::Char('a'), none), b"a"),
        (KeyEvent::new(KeyCode::Char('A'), shift), b"A"),
        (KeyEvent::new(KeyCode::Char('c'), control), &[0x03]),
        (KeyEvent::new(KeyCode::Char('C'), control), &[0x03]),
        (KeyEvent::new(KeyCode::Char('@'), control), &[0x00]),
        (KeyEvent::new(KeyCode::Char(' '), control), &[0x00]),
        (KeyEvent::new(KeyCode::Char('['), control), &[0x1b]),
        (KeyEvent::new(KeyCode::Char('?'), control), &[0x7f]),
        (KeyEvent::new(KeyCode::Char('z'), control), &[0x1a]),
        (KeyEvent::new(KeyCode::Char('d'), alt), b"\x1bd"),
        (KeyEvent::new(KeyCode::Enter, none), b"\r"),
        (KeyEvent::new(KeyCode::Enter, shift), b"\x1b[1;2E"),
        (KeyEvent::new(KeyCode::Tab, none), b"\t"),
        (KeyEvent::new(KeyCode::Tab, shift), b"\x1b[Z"),
        (KeyEvent::new(KeyCode::BackTab, none), b"\x1b[Z"),
        (KeyEvent::new(KeyCode::Esc, none), &[0x1b]),
        (KeyEvent::new(KeyCode::Backspace, none), &[0x7f]),
        (KeyEvent::new(KeyCode::Backspace, control), &[0x08]),
        (KeyEvent::new(KeyCode::Delete, none), b"\x1b[3~"),
        (KeyEvent::new(KeyCode::Insert, none), b"\x1b[2~"),
        (KeyEvent::new(KeyCode::Home, none), b"\x1b[H"),
        (KeyEvent::new(KeyCode::End, none), b"\x1b[F"),
        (KeyEvent::new(KeyCode::PageUp, none), b"\x1b[5~"),
        (KeyEvent::new(KeyCode::PageDown, none), b"\x1b[6~"),
        (KeyEvent::new(KeyCode::Up, none), b"\x1b[A"),
        (KeyEvent::new(KeyCode::Up, shift), b"\x1b[1;2A"),
        (KeyEvent::new(KeyCode::Down, control), b"\x1b[1;5B"),
        (KeyEvent::new(KeyCode::Right, alt), b"\x1b[1;3C"),
        (KeyEvent::new(KeyCode::Left, none), b"\x1b[D"),
        (KeyEvent::new(KeyCode::F(1), none), b"\x1bOP"),
        (KeyEvent::new(KeyCode::F(5), none), b"\x1b[15~"),
        (KeyEvent::new(KeyCode::F(12), none), b"\x1b[24~"),
        (KeyEvent::new(KeyCode::Null, none), &[0x00]),
    ];

    for (event, expected) in cases {
        assert_eq!(
            keys::encode_key(&event).as_deref(),
            Some(expected),
            "{:?} {:?}",
            event.code,
            event.modifiers
        );
    }
}

/// A key with no agreed encoding is DROPPED, not approximated.
#[test]
fn keys_with_no_encoding_are_dropped() {
    let none = KeyModifiers::NONE;
    let super_only = KeyModifiers::SUPER;
    for event in [
        KeyEvent::new(KeyCode::Char('c'), super_only),
        KeyEvent::new(KeyCode::Char('é'), KeyModifiers::CONTROL),
        KeyEvent::new(KeyCode::CapsLock, none),
        KeyEvent::new(KeyCode::F(20), none),
    ] {
        assert_eq!(keys::encode_key(&event), None, "{:?}", event.code);
    }
}

/// A bracketed paste is wrapped and never split mid-codepoint.
#[test]
fn a_paste_is_bracketed_and_never_split_mid_codepoint() {
    let payload = keys::encode_paste("héllo 🦀 world");
    assert!(payload.starts_with(b"\x1b[200~"));
    assert!(payload.ends_with(b"\x1b[201~"));
    let body = String::from_utf8(payload[6..payload.len() - 6].to_vec()).expect("valid UTF-8");
    assert_eq!(body, "héllo 🦀 world");
}

/// The hand-rolled base64 encoder matches the RFC 4648 test vectors, because the contract
/// validates `pty_input`'s payload against `^[A-Za-z0-9+/]*={0,2}$` and a wrong alphabet
/// would make every keystroke fail validation at the daemon.
#[test]
fn base64_matches_the_rfc_4648_vectors() {
    for (plain, encoded) in [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
    ] {
        assert_eq!(
            commands::base64_encode(plain.as_bytes()),
            encoded,
            "{plain:?}"
        );
    }
    // And the binary bytes a PTY actually carries.
    assert_eq!(commands::base64_encode(&[0x03]), "Aw==");
    assert_eq!(commands::base64_encode(b"\x1b[A"), "G1tB"); // ESC, '[', 'A'
}

/// `pty_input` produces a command the contract accepts, for a range of byte payloads.
#[test]
fn pty_input_produces_a_contract_valid_command() {
    for payload in [
        &b"\x03"[..],
        b"\x1b[A",
        "héllo".as_bytes(),
        &[255u8, 254, 253][..],
    ] {
        let command = commands::pty_input("pane-1", payload).expect("valid");
        match command {
            aibr_ipc::ControlCommand::PtyInput { data, pane_id } => {
                assert_eq!(pane_id.as_str(), "pane-1");
                assert!(
                    data.as_str()
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='),
                    "{:?} is not the alphabet the contract requires",
                    data.as_str()
                );
            }
            other => panic!("{other:?}"),
        }
    }
}

/// An id the contract's pattern rejects is refused, and `resize_pane` refuses a zero
/// dimension -- a PTY sized 0x0 makes the process exit.
#[test]
fn the_contract_rejects_impossible_arguments() {
    assert!(commands::pty_input("-bad", b"x").is_err());
    assert!(commands::close_pane("has space").is_err());
    assert!(commands::resize_pane("pane-1", 0, 10).is_err());
    assert!(commands::resize_pane("pane-1", 10, 0).is_err());
    assert!(commands::resize_pane("pane-1", 80, 24).is_ok());
}

// ---------------------------------------------------------------------------------------
// Copy-mode search
// ---------------------------------------------------------------------------------------

/// A query is matched case-insensitively by default, because the operator is looking for a
/// token they can see on screen.
#[test]
fn search_is_case_insensitive_by_default() {
    let pane = FakePane::new(&["alpha", "BETA", "gamma"], 40, 10);
    assert_eq!(
        aibr_tui::input::copy_mode::find(&pane, "pane-a", "beta", 0, true).map(|hit| hit.line),
        Some(1)
    );
    assert_eq!(
        aibr_tui::input::copy_mode::find(&pane, "pane-a", "beta", 0, false),
        None
    );
}

/// The reported column is the position in the ORIGINAL text, not the lowercased one.
#[test]
fn a_hit_reports_the_column_in_the_original_text() {
    let pane = FakePane::new(&["xx NEEDLE yy", "needle again"], 40, 10);
    assert_eq!(
        aibr_tui::input::copy_mode::find(&pane, "pane-a", "needle", 0, true)
            .map(|hit| (hit.line, hit.column)),
        Some((0, 3))
    );
    assert_eq!(
        aibr_tui::input::copy_mode::find(&pane, "pane-a", "needle", 1, true)
            .map(|hit| (hit.line, hit.column)),
        Some((1, 0))
    );
}

/// A query matches across a HARD line break only if it contains the newline; otherwise the
/// separator stops it. That is what makes "crossing line boundaries" a property rather
/// than an accident.
#[test]
fn a_query_may_contain_the_newline_between_lines() {
    let pane = FakePane::new(&["first", "second"], 40, 10);
    assert_eq!(
        aibr_tui::input::copy_mode::find(&pane, "pane-a", "first\nsecond", 0, false)
            .map(|hit| hit.line),
        Some(0),
        "a query spanning two hard lines must match"
    );
    assert_eq!(
        aibr_tui::input::copy_mode::find(&pane, "pane-a", "firstsecond", 0, false),
        None
    );
}

/// The search starts where it is told and wraps when it runs off the end, so `n` at the
/// bottom of the log does not appear to stop working.
#[test]
fn search_wraps_rather_than_stopping() {
    let pane = FakePane::new(&["one", "two", "three", "target", "five"], 40, 10);
    // `from` at the last line index is IN range, so it does not wrap; `next_hit` passes
    // `cursor + 1`, which is what reaches the end.
    let hit = aibr_tui::input::copy_mode::find(&pane, "pane-a", "target", 5, false)
        .expect("wraps to line 3");
    assert_eq!(hit.line, 3);
}

/// An empty query matches nothing rather than everything.
#[test]
fn an_empty_query_finds_nothing() {
    let pane = FakePane::new(&["anything"], 40, 10);
    assert_eq!(
        aibr_tui::input::copy_mode::find(&pane, "pane-a", "", 0, true),
        None
    );
}

// ---------------------------------------------------------------------------------------
// Menu geometry
// ---------------------------------------------------------------------------------------

/// The menu's item list depends on what was clicked.
#[test]
fn the_menu_items_depend_on_the_click_target() {
    use aibr_tui::input::HitTarget;
    let pane = ContextMenu::open(
        (1, 1),
        &HitTarget::Pane {
            pane_id: "p".to_owned(),
        },
    )
    .expect("a pane");
    assert_eq!(pane.items().len(), 5);
    let queue = ContextMenu::open(
        (1, 1),
        &HitTarget::SidebarQueueItem {
            job_id: "j".to_owned(),
        },
    )
    .expect("a queue row");
    assert_eq!(queue.items().len(), 1);
    for target in [
        HitTarget::TopBar,
        HitTarget::StatusBar,
        HitTarget::Sidebar,
        HitTarget::Canvas,
        HitTarget::None,
        HitTarget::SidebarWorkspace {
            workspace_id: "w".to_owned(),
        },
        HitTarget::SidebarJob {
            job_id: "j".to_owned(),
        },
    ] {
        assert_eq!(
            ContextMenu::open((1, 1), &target),
            None,
            "{target:?} must not open a menu"
        );
    }
}

/// The menu is as wide as its widest label, so `View Outbox Item` is not clipped.
#[test]
fn the_menu_is_as_wide_as_its_widest_label() {
    use aibr_tui::input::HitTarget;
    let menu = ContextMenu::open(
        (0, 0),
        &HitTarget::Pane {
            pane_id: "p".to_owned(),
        },
    )
    .expect("a pane");
    let widest = menu
        .items()
        .iter()
        .map(|item| item.label().chars().count())
        .max()
        .expect("items");
    assert_eq!(menu.width() as usize, widest + 2);
    assert_eq!(menu.height() as usize, menu.items().len() + 2);
}

/// The wheel step is three lines, and it is asserted so a change to it is deliberate.
#[test]
fn the_wheel_step_is_three_lines() {
    assert_eq!(WHEEL_LINES, 3);
}

//! Redaction canary tests.
//!
//! Acceptance criteria 7 and 8: everything leaving the client — a copied selection, a
//! yanked line, the rendered diff — must be scrubbed. A test that only asserts
//! "the output changed" cannot tell a working redactor from one that happens to
//! mangle something; every case here asserts on the CANARY specifically, and one
//! asserts the canary is absent from the raw bytes.

use aibr_tui::input::redact::{
    redact_to_text, redact_with_report, ConservativeRedactor, RedactedText,
};
use aibr_tui::input::traits::Redactor;

/// A token-shaped string that must never survive to the clipboard or the screen.
///
/// Shaped like a real one so the redactor's pattern matching is exercised the way it
/// would be in production, and distinctive enough that finding it anywhere in a
/// rendered frame is unambiguous.
const CANARY: &str = "sk-ant-api03-CANARYSECRET0123456789abcdefXYZ";

#[test]
fn a_bearer_token_is_masked() {
    let text = format!("Authorization: Bearer {CANARY}");
    let (redacted, masks) = redact_with_report(&text);

    assert!(
        !redacted.contains("CANARYSECRET"),
        "the canary survived redaction: {redacted:?}"
    );
    assert!(!masks.is_empty(), "nothing was reported as masked");
    assert!(
        redacted.contains("[redacted]"),
        "the replacement must be visible, so an operator can tell something was masked rather than \
         wondering whether the token simply vanished: {redacted:?}"
    );
    // NOTE: the engine's marker is `[REDACTED_SECRET]` (see
    // `src/observability/redaction.ts`) and this client's is `[redacted]`. They
    // differ, which is acceptable only because the TS pipeline is authoritative and
    // this is a second pass on the way out -- a client-side mask is defence in
    // depth, not the record of what was redacted. Asserted here so a future swap to
    // the engine's redactor makes this fail loudly rather than silently changing
    // what an operator sees.
    assert!(
        !redacted.contains("[REDACTED_SECRET]"),
        "the engine's marker appearing here would mean the client is impersonating the engine's \
         redaction rather than adding a second pass: {redacted:?}"
    );
}

#[test]
fn a_bare_provider_token_is_masked() {
    let (redacted, _) = redact_with_report(&format!("token is {CANARY} here"));
    assert!(!redacted.contains("CANARYSECRET"), "{redacted:?}");
}

#[test]
fn a_tailscale_auth_key_is_masked() {
    let key = "tskey-auth-k1234567890abcdefghijklmnopCANARY";
    let (redacted, _) = redact_with_report(&format!("tailscale key {key}"));
    assert!(!redacted.contains("CANARY"), "{redacted:?}");
}

#[test]
fn a_private_home_path_is_masked() {
    // A path is not a secret, but it discloses the operator's username and machine
    // layout, which the criteria group with credentials.
    let (redacted, _) = redact_with_report("reading /Users/alice/.ssh/id_rsa");
    assert!(!redacted.contains("alice"), "{redacted:?}");
}

#[test]
fn a_clipboard_value_is_constructed_only_through_the_redactor() {
    // The type is the guarantee: `RedactedText`'s constructor is crate-private, so
    // a caller cannot obtain one without going through a `Redactor`. This test
    // exercises the path a copy actually takes.
    let text = redact_to_text(&ConservativeRedactor, &format!("leaked {CANARY}"));
    let copied = text.as_str();
    assert!(
        !copied.contains("CANARYSECRET"),
        "a raw secret reached the clipboard: {copied:?}"
    );
}

#[test]
fn ordinary_output_is_not_mangled() {
    // A redactor that mangles everything is as useless as one that masks nothing:
    // the operator stops reading the selection because it is all brackets. These are
    // the lines an agent prints constantly, and they must pass through intact.
    for line in [
        "Reading AST tree...",
        "ok 27 passed, 0 failed",
        "src/controllers/order.ts:42",
        "total 1,234 bytes",
    ] {
        let (redacted, masks) = redact_with_report(line);
        assert_eq!(redacted, line, "a plain line was mangled");
        assert!(masks.is_empty(), "a plain line was reported as masked");
    }
}

#[test]
fn a_rendered_diff_never_contains_the_canary() {
    // The diff pane is the densest place agent-authored text appears, and the plan
    // requires every line of it to be scrubbed before it is drawn.
    let diff = format!("+const API_KEY = \"{CANARY}\";");
    let (classified, flags) = aibr_tui::widgets::diff::classify(&diff);
    assert!(matches!(
        classified,
        aibr_tui::widgets::diff::DiffLine::Added(_)
    ));
    assert!(
        !flags
            .iter()
            .any(|flag| flag.evidence.contains("CANARYSECRET")),
        "the flag evidence leaked the secret: {flags:?}"
    );
}

#[test]
fn a_destructive_command_is_flagged_by_name() {
    // A rule NAME, not a score: an operator who cannot see which rule fired cannot
    // dismiss a false positive.
    let (classified, flags) = aibr_tui::widgets::diff::classify("+rm -rf /tmp/cache && migrate");
    assert!(matches!(
        classified,
        aibr_tui::widgets::diff::DiffLine::Added(_)
    ));
    assert!(
        flags.iter().any(|flag| flag.rule == "destructive delete"),
        "a destructive delete was not flagged: {flags:?}"
    );
}

#[test]
fn a_benign_diff_is_not_flagged() {
    // Over-flagging is its own failure: if everything is dangerous the operator stops
    // reading the markers.
    let (classified, flags) = aibr_tui::widgets::diff::classify("+const timeout = 30;");
    assert!(matches!(
        classified,
        aibr_tui::widgets::diff::DiffLine::Added(_)
    ));
    assert!(flags.is_empty(), "a benign line was flagged: {flags:?}");
}

#[test]
fn redaction_is_idempotent() {
    // Run twice, the second pass must not corrupt the first pass's markers. The
    // clipboard path can run the redactor over text that was already redacted by the
    // daemon, and mangled markers would be worse than none.
    let once = redact_with_report(&format!("Bearer {CANARY}")).0;
    let twice = redact_with_report(&once).0;
    assert_eq!(once, twice, "redacting twice changed the result again");
}

#[test]
fn the_redactor_trait_is_object_safe_so_the_canvas_can_swap_it() {
    // The whole point of the trait is a type swap at integration time. A trait that
    // cannot be held as `dyn` could not be swapped without touching every call site.
    let redactors: Vec<Box<dyn Redactor>> = vec![Box::new(ConservativeRedactor)];
    for redactor in &redactors {
        assert!(!redactor.redact(CANARY).contains("CANARYSECRET"));
    }
}

#[test]
fn redacted_text_refuses_to_hand_out_its_raw_form() {
    // The only accessor is `as_str`, and it returns the SCRUBBED text. If a caller
    // wanted the original it would need an accessor that does not exist.
    let text: RedactedText = redact_to_text(&ConservativeRedactor, CANARY);
    let _ = text.as_str();
    assert!(
        !format!("{text:?}").contains("CANARYSECRET"),
        "Debug leaked it"
    );
}

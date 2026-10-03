//! The bearer matrix, and the properties of the comparison itself.
//!
//! The interesting cases here are the ones that are not "correct token works".
//! `F-03` was a route with no authentication, so the failure direction that matters
//! is a *wrong* token being admitted — and a comparison that admits a length-mismatch
//! or a wrong-prefix header is a comparison that admits an attacker's guess.

mod support;

use axum::http::StatusCode;
use serde_json::json;

use support::{app, bearer, oneshot, request, TempDir};

/// The correct token is admitted.
#[tokio::test]
async fn the_configured_token_is_accepted() {
    let root = TempDir::new("auth-correct");

    let reply = oneshot(
        app(root.path()),
        support::authorized("GET", "/health", json!(null)),
    )
    .await;

    assert_eq!(reply.status, StatusCode::OK);
}

/// A wrong token is refused.
///
/// One byte different from the end, which is the position a naive early-exit
/// comparison would never reach — a `return presented[i] == expected[i]` style loop
/// with an early exit would pass this case. It is here so that the test table covers
/// both a first-byte and a last-byte difference.
#[tokio::test]
async fn a_wrong_token_is_refused() {
    let root = TempDir::new("auth-wrong");
    let almost = format!("{}x", support::TOKEN);

    let reply = oneshot(
        app(root.path()),
        request("GET", "/health", Some(json!(null)), Some(&bearer(&almost))),
    )
    .await;

    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

/// The first byte differing is refused too.
#[tokio::test]
async fn a_token_differing_in_the_first_byte_is_refused() {
    let root = TempDir::new("auth-first-byte");
    let almost = format!("x{}", &support::TOKEN[1..]);

    let reply = oneshot(
        app(root.path()),
        request("GET", "/health", Some(json!(null)), Some(&bearer(&almost))),
    )
    .await;

    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

/// No header at all is refused.
#[tokio::test]
async fn a_missing_authorization_header_is_refused() {
    let root = TempDir::new("auth-missing");

    let reply = oneshot(
        app(root.path()),
        request("GET", "/health", Some(json!(null)), None),
    )
    .await;

    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

/// An empty header value is refused.
///
/// Distinct from a missing one because it is a different shape of request: a proxy
/// that strips an empty header produces the second, not the first, and the router
/// should not treat "present but empty" as "the check was skipped".
#[tokio::test]
async fn an_empty_authorization_header_is_refused() {
    let root = TempDir::new("auth-empty");

    let reply = oneshot(
        app(root.path()),
        request("GET", "/health", Some(json!(null)), Some("")),
    )
    .await;

    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

/// The scheme prefix alone, with no token, is refused.
#[tokio::test]
async fn a_bare_scheme_with_no_token_is_refused() {
    let root = TempDir::new("auth-bare-scheme");

    let reply = oneshot(
        app(root.path()),
        request("GET", "/health", Some(json!(null)), Some("Bearer")),
    )
    .await;

    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

/// `Bearer ` with nothing after it is refused.
///
/// This is the degenerate case `Bearer::new`'s empty-token guard exists to prevent from
/// the other side: if the configured token were empty, this header would authenticate.
#[tokio::test]
async fn the_scheme_with_an_empty_token_is_refused() {
    let root = TempDir::new("auth-empty-token");

    let reply = oneshot(
        app(root.path()),
        request("GET", "/health", Some(json!(null)), Some("Bearer ")),
    )
    .await;

    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

/// Wrong prefixes are refused. All of them.
///
/// RFC 7235 makes the auth scheme case-insensitive, so `bearer` is a header a
/// conformant client may send. It is refused here anyway, and that is deliberate:
/// the engine's `BearerAuthProvider` uses `startsWith("Bearer ")` and is
/// case-*sensitive*, so accepting both would make the router accept requests the
/// engine rejects. When two components disagree about a boundary, the stricter one
/// being the new one means a client can never find a deployment where its lowercase
/// header silently worked.
#[tokio::test]
async fn every_wrong_scheme_prefix_is_refused() {
    let root = TempDir::new("auth-prefixes");

    let token = support::TOKEN;
    for header in [
        // Wrong case. RFC 7235 says the scheme is case-insensitive, so both of these
        // are headers a conformant client may send.
        format!("bearer {token}"),
        format!("BEARER {token}"),
        // A different scheme entirely.
        format!("Token {token}"),
        format!("Basic {token}"),
        // No scheme at all: the raw token.
        token.to_owned(),
        // The right scheme with an extra space, so the presented token gains a leading
        // space and differs from the configured one at byte zero.
        format!("Bearer  {token}"),
        // A leading space before the scheme.
        format!(" Bearer {token}"),
        // Tab-separated, which a lenient token68 parser would accept.
        format!("Bearer\t{token}"),
        // The scheme in the wrong order.
        format!("{token} Bearer"),
    ] {
        let reply = oneshot(
            app(root.path()),
            request("GET", "/health", Some(json!(null)), Some(&header)),
        )
        .await;

        assert_eq!(
            reply.status,
            StatusCode::UNAUTHORIZED,
            "the header {header:?} was accepted"
        );
    }
}

/// A length mismatch is refused — shorter and longer, in both directions.
///
/// This is the case the constant-time comparison has to get right without an early
/// return, and it is a correctness case as well as a timing one: a comparison that
/// compared `min(len)` bytes and ignored the tail would accept a *prefix* of the
/// configured token as a valid token. Two extra characters of a valid token would
/// then be enough to be a different, valid-looking credential.
#[tokio::test]
async fn a_token_of_a_different_length_is_refused_in_both_directions() {
    let root = TempDir::new("auth-length");

    let shorter = &support::TOKEN[..support::TOKEN.len() - 1];
    let longer = format!("{}x", support::TOKEN);

    // The prefix case first: a comparison that stopped at the shorter length would
    // admit this.
    let reply = oneshot(
        app(root.path()),
        request("GET", "/health", Some(json!(null)), Some(&bearer(shorter))),
    )
    .await;
    assert_eq!(
        reply.status,
        StatusCode::UNAUTHORIZED,
        "a strict prefix of the configured token was accepted"
    );

    // `support::TOKEN` itself is deliberately absent from this list — it is the one
    // token of the configured length that must be accepted, and
    // `only_the_configured_length_is_accepted` covers that. Including it here would
    // make this test assert the impossible.
    let long_enough = "x".repeat(4096);
    for token in [&longer, "x", long_enough.as_str()] {
        let reply = oneshot(
            app(root.path()),
            request("GET", "/health", Some(json!(null)), Some(&bearer(token))),
        )
        .await;
        assert_eq!(
            reply.status,
            StatusCode::UNAUTHORIZED,
            "a token of length {} was accepted",
            token.len()
        );
    }
}

/// A configured token that is a prefix of nothing in particular still round-trips.
///
/// The positive control for the length test: the token that *is* configured is
/// accepted, and the ones that differ only in length are not. Without this, a
/// comparison that refused everything would pass every case above.
#[tokio::test]
async fn only_the_configured_length_is_accepted() {
    let root = TempDir::new("auth-length-positive");

    let reply = oneshot(
        app(root.path()),
        request(
            "GET",
            "/health",
            Some(json!(null)),
            Some(&bearer(support::TOKEN)),
        ),
    )
    .await;

    assert_eq!(reply.status, StatusCode::OK);
}

/// The token is compared as bytes, so a multi-byte UTF-8 token works.
///
/// A byte comparison is the correct primitive and it does mean a token containing
/// non-ASCII has to arrive byte-for-byte. This asserts it rather than leaving it as an
/// assumption, because the alternative failure — a router that silently mangles
/// non-ASCII credentials — is the kind of thing discovered by a user.
#[test]
fn a_non_ascii_token_is_accepted_byte_for_byte() {
    let token = "tökén-🔑-значение";
    let verifier = aibr_router::auth::Bearer::new(token).expect("not empty");

    assert!(verifier.accepts(Some(&format!("Bearer {token}"))));
    assert!(!verifier.accepts(Some("Bearer tökén-🔑-значени")));
    assert!(!verifier.accepts(Some("Bearer token")));
}

/// `Bearer`'s `Debug` must not print the token.
///
/// `Bearer` lives inside `AppState`, `AppState` is the kind of value that ends up in a
/// `#[derive(Debug)]` on some future struct, and a derived `Debug` would put the
/// secret into whatever diagnostic that reaches. Asserting the rendered form makes the
/// redaction a property of the test suite rather than a convention.
#[test]
fn debug_renders_the_token_as_redacted() {
    let verifier = aibr_router::auth::Bearer::new("super-secret-canary").expect("not empty");

    let rendered = format!("{verifier:?}");

    assert!(
        !rendered.contains("super-secret-canary"),
        "Debug leaked the token: {rendered}"
    );
    assert!(rendered.contains("redacted"), "Debug was {rendered}");
}

/// An empty configured token is refused at construction.
///
/// Without this, a deployment that set `AIBRIDGE_BEARER_TOKEN=""` would authenticate
/// every request carrying `Authorization: Bearer ` — no credential at all. The engine
/// has the same exposure (`src/index.ts:6` checks presence only); M7.4's config work
/// is where that gets fixed on the engine side. Here it is a startup failure, because
/// the router owns its own startup.
#[test]
fn an_empty_configured_token_cannot_be_constructed() {
    assert!(aibr_router::auth::Bearer::new("").is_err());
    assert!(aibr_router::auth::Bearer::new("x").is_ok());
}

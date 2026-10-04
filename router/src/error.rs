//! The router's entire error vocabulary, and the rules for what may appear in it.
//!
//! Every failure a caller can observe is one of these five variants, and every one
//! of them serialises to the same two-field body: a static `error` string and the
//! `schemaVersion` this binary speaks. There is deliberately no variant that
//! carries a message, a path, a field name from the request, or anything else
//! derived from caller input.
//!
//! # Why no error body echoes anything
//!
//! Two reasons, and the second is the one that actually constrains the design.
//!
//! First, an error body that quotes the request is a reflected-input surface on a
//! trust boundary. JSON encoding makes injection impossible in the strict sense,
//! but "impossible to break out of" is a much weaker property than "there is
//! nothing there to attack", and a 32 MiB process that concatenates untrusted
//! text into allocations is a 32 MiB process doing untrusted-sized work.
//!
//! Second, and decisively: this crate is Tier 1. It is a *rejection filter*. The
//! information an attacker wants — which project roots exist, which capability a
//! given source holds, whether a job id is real — is exactly the information that
//! only the worker is entitled to answer. A Tier 1 error body that varies with the
//! reason for rejection is a Tier 1 oracle for Tier 2's decisions. See the crate
//! docs and ADR 0008 §2.2.
//!
//! This is why [`ApiError::InvalidPayload`] takes a `&'static str` drawn from a
//! closed set in this crate rather than a `String` built at the call site. A
//! `String` parameter is a hole every future caller widens by accident.

use std::borrow::Cow;

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::CONTRACT_VERSION;

/// `WWW-Authenticate` value.
///
/// RFC 7235 §4.1 lists `Bearer` among the schemes registered at the time, and
/// `realm` is required. No `error` parameter is sent: the two values RFC 6750
/// §3.1 defines (`invalid_request`, `invalid_token`) both tell a prober which of
/// two things it got wrong.
const WWW_AUTHENTICATE: &str = r#"Bearer realm="aibr-router""#;

/// Every way a request can be refused at the structural gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiError {
    /// Absent, malformed, or wrong bearer. One variant for all three, so the
    /// response cannot be used to distinguish "no header" from "bad token" — the
    /// distinction an offline guessing attack wants more than anything else.
    Unauthorized,

    /// Well-formed HTTP, malformed body. The `&'static str` is a closed-set
    /// discriminator chosen at the call site, never request-derived text.
    InvalidPayload(&'static str),

    /// Unsupported `schemaVersion`. Its own variant, not a member of
    /// `InvalidPayload`, because ADR 0008 §2.3 and `SF-14` require this to be an
    /// *explicit refusal* rather than a generic parse failure: an operator holding
    /// a v2 client needs to be told the version, not told the body was bad.
    UnsupportedSchemaVersion,

    /// No such route, or no such job. Also what the two `/v1/mesh/*` paths answer
    /// (ADR 0008 §6) — see [`crate::routes`].
    NotFound,

    /// Body above [`crate::validate::MAX_BODY_BYTES`].
    PayloadTooLarge,

    /// The admission store refused or failed the write (`503`, M7.5).
    ///
    /// **The one variant here that is about the router's own state rather than the
    /// request**, and it is deliberately the only one. It exists because a `202`
    /// without a committed row is a lie the caller cannot detect, so a store that
    /// cannot commit has to be answerable in a way that is not `202`
    /// ([`crate::outbox`]'s module docs).
    ///
    /// `503` and not `500`: the condition is expected to clear, and `503` is what
    /// tells a caller's retry loop — which is the documented recovery path for every
    /// other crash-window row — that retrying is the right response. A `500` reads as
    /// "this request is broken" and a caller that believes it will not retry.
    ///
    /// It still carries no detail. [`crate::outbox::StoreError`] knows whether the
    /// store was locked, read-only, or at a schema version this build refuses, and
    /// none of that reaches a socket: it is operator configuration, it goes to the
    /// process's stderr, and the caller learns the one thing it can act on, which is
    /// that the work was not accepted and may be resubmitted.
    StoreUnavailable,
    /// Queue or inflight bound exceeded (M7.12, SF-15, `429`).
    TooManyRequests { retry_after_secs: u32 },
}

impl ApiError {
    /// The status this error maps to.
    ///
    /// `400` for shape, `401` for identity, `404` for absence, `413` for size.
    /// There is no `403` anywhere in this crate, and the absence is the point:
    /// "you are forbidden" is a Tier 2 sentence and this component has no way to
    /// earn the right to say it. Returning `403` here would imply the router knows
    /// something about the caller's permissions, which by construction it does not.
    fn status(self) -> StatusCode {
        match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::InvalidPayload(_) | Self::UnsupportedSchemaVersion => StatusCode::BAD_REQUEST,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::StoreUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::TooManyRequests { .. } => StatusCode::TOO_MANY_REQUESTS,
        }
    }

    /// The `error` field of the response body.
    ///
    /// Static in every arm but one, for the reasons in this module's docs.
    fn message(self) -> Cow<'static, str> {
        match self {
            Self::Unauthorized => Cow::Borrowed("unauthorized"),
            Self::InvalidPayload(discriminator) => Cow::Borrowed(discriminator),
            // Names the version this binary speaks rather than echoing the version
            // it was sent. Reflecting the received value buys the caller nothing it
            // cannot read out of its own request, and it would make this string
            // request-dependent for the first time.
            //
            // "will not coerce" is in the string because an operator who sees only
            // "unsupported" reasonably assumes something will be inferred from the
            // version they sent. Nothing will.
            Self::UnsupportedSchemaVersion => Cow::Owned(format!(
                "unsupported schemaVersion; this router speaks {CONTRACT_VERSION:?} and \
                 will not coerce, downgrade, or ignore another version"
            )),
            Self::NotFound => Cow::Borrowed("not found"),
            Self::PayloadTooLarge => Cow::Borrowed("request body exceeds the ingress limit"),
            // Says the work was NOT accepted, because that is the whole content of
            // this refusal and the thing a caller's retry loop branches on. It does
            // not say *why* the store is unavailable -- see the variant's docs.
            Self::StoreUnavailable => {
                Cow::Borrowed("the router cannot durably accept work right now; retry")
            }
            Self::TooManyRequests { .. } => {
                Cow::Borrowed("too many requests; queue or rate bound exceeded; retry later")
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status(),
            axum::Json(json!({ "error": self.message(), "schemaVersion": CONTRACT_VERSION })),
        )
            .into_response();

        if self == Self::Unauthorized {
            response.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                header::HeaderValue::from_static(WWW_AUTHENTICATE),
            );
        }
        if let Self::TooManyRequests { retry_after_secs } = self {
            response.headers_mut().insert(
                header::RETRY_AFTER,
                header::HeaderValue::from(retry_after_secs),
            );
        }

        response
    }
}

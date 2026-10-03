//! Bearer authentication at the router's edge.
//!
//! # Why this exists at all, given the engine already has one
//!
//! `GET /jobs/:id` is finding `F-03`: it is registered by `createApp()` with no
//! authentication whatsoever ([`src/server/routes/jobs.ts:5`](../../src/server/routes/jobs.ts),
//! [`src/server/app.ts:38`](../../src/server/app.ts)), so the record it returns —
//! prompt text, project path, source agent, callback metadata — is readable by
//! anyone who can reach the socket. Moving the route into the router and putting
//! *every* route behind the bearer, reads included, is the closure.
//!
//! The important structural property is the "every". A read route is exactly where
//! a "we only need auth on writes" instinct shows up, and the instinct is what
//! produced `F-03`.
//!
//! # Why `subtle` and not a hand-rolled loop
//!
//! See the dependency comment in `Cargo.toml`. The short version: `ring` compiles
//! C and asm, which is what M7.9's `cargo zigbuild` musl matrix exists to avoid,
//! and `hmac` would require inventing a keyed-MAC construction this crate has no
//! business having. `subtle` is the primitive Node's `crypto.timingSafeEqual` is.

use subtle::ConstantTimeEq;

/// The exact header prefix this router accepts.
///
/// Case-sensitive, unlike RFC 7235's scheme, which is case-insensitive. That is a
/// deliberate narrowing, not an oversight: the engine's
/// `BearerAuthProvider.validate` ([`src/security/auth-provider.ts:12`](../../src/security/auth-provider.ts))
/// uses `startsWith("Bearer ")`, so a client that sends `bearer` works against the
/// engine today and will get a `401` here. When two components disagree, the
/// stricter one being the new one means a client can never find a deployment where
/// its lowercase header silently worked; the migration cost is one `401` that is
/// fixed by capitalising one word. The alternative — accepting both — would mean
/// the router accepts a request the engine would reject, which is the direction
/// that erodes a boundary.
const BEARER_PREFIX: &str = "Bearer ";

/// A configured bearer token and the check against it.
///
/// Holds the token as `Vec<u8>` rather than `String` so the comparison is over
/// bytes with no UTF-8 validity step in the middle of it. `validate_utf8` is
/// cheap, but "cheap and before the comparison" is the kind of thing that stays
/// cheap and stays before the comparison.
#[derive(Clone)]
pub struct Bearer {
    expected: Vec<u8>,
}

impl std::fmt::Debug for Bearer {
    /// Deliberately opaque. `Bearer` appears in `AppState`, `AppState` may end up
    /// in a `Debug` chain, and a derived `Debug` here would put the token in
    /// whatever diagnostic that reaches. `no-secret` is what a reader searching a
    /// log for the token will find instead.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Bearer { expected: <redacted> }")
    }
}

impl Bearer {
    /// Build a verifier for `token`.
    ///
    /// An empty token is rejected here rather than at comparison time. An empty
    /// expected value would make `Authorization: Bearer ` — a header carrying no
    /// credential at all — authenticate successfully, which is the kind of
    /// degenerate configuration that survives to production because nothing fails
    /// loudly when it is set. The engine has the same exposure
    /// (`AIBRIDGE_BEARER_TOKEN` is only checked for presence, `src/index.ts:7`) and
    /// M7.4's config work is where that gets fixed on the engine side; here it is
    /// a startup failure because the router controls its own startup.
    pub fn new(token: &str) -> Result<Self, BearerConfigError> {
        if token.is_empty() {
            return Err(BearerConfigError::Empty);
        }
        Ok(Self {
            expected: token.as_bytes().to_vec(),
        })
    }

    /// Validate an `Authorization` header value.
    ///
    /// Returns `false` — never an error, never a reason — for every failure. The
    /// caller turns `false` into a single `401` body; see [`ApiError::Unauthorized`].
    pub fn accepts(&self, header: Option<&str>) -> bool {
        let Some(header) = header else {
            return false;
        };

        // `strip_prefix` over a fixed, non-secret, public constant. The prefix
        // check leaks nothing about the token, and short-circuiting on it costs
        // nothing because there is no secret on either side of it.
        let Some(presented) = header.strip_prefix(BEARER_PREFIX) else {
            return false;
        };

        constant_time_eq(presented.as_bytes(), &self.expected)
    }
}

/// Constant-time equality over two byte slices.
///
/// The two failure conditions — different lengths, and a byte that differs at some
/// index — are combined with a bitwise AND rather than `&&`. That is the whole
/// point of the function: `&&` short-circuits, so with it the *content*
/// comparison would be skipped whenever the lengths differ, and the duration of
/// the check would depend on a property of the caller's input rather than only on
/// the inputs themselves. `subtle::Choice`'s `BitAnd` runs both sides
/// unconditionally.
///
/// On the length check specifically, so that the reasoning is not misread as
/// "lengths must be secret": they are not, and cannot be. The caller chooses the
/// length of the token it presents. What a correct implementation must not leak is
/// *where* two equal-length candidates first differ, because that is what turns a
/// comparison into an oracle that recovers the expected value one byte at a time.
/// Length is observable by inspection of the request the caller itself built.
fn constant_time_eq(presented: &[u8], expected: &[u8]) -> bool {
    let same_length = presented.len().ct_eq(&expected.len());
    let same_bytes = presented.ct_eq(expected);
    bool::from(same_length & same_bytes)
}

/// `Bearer::new` refused the token it was given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BearerConfigError {
    /// The variable was not set at all.
    Missing,
    /// The variable was set to the empty string. See [`Bearer::new`].
    Empty,
}

impl std::fmt::Display for BearerConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // No token in this message, by construction: the only token-shaped value
        // that reaches this type is the empty string.
        match self {
            Self::Missing => f.write_str(concat!(
                "AIBRIDGE_BEARER_TOKEN",
                " is required; refusing to start"
            )),
            Self::Empty => f.write_str(concat!(
                "AIBRIDGE_BEARER_TOKEN",
                " is empty; refusing to start"
            )),
        }
    }
}

impl std::error::Error for BearerConfigError {}

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn equal_slices_compare_equal() {
        assert!(constant_time_eq(b"token", b"token"));
    }

    #[test]
    fn empty_slices_compare_equal() {
        // Not reachable through `Bearer::new` (which rejects an empty token), but
        // the primitive must still be correct on its own terms.
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn length_mismatch_is_not_equal() {
        assert!(!constant_time_eq(b"token", b"token-"));
        assert!(!constant_time_eq(b"tok", b"token"));
    }

    #[test]
    fn single_differing_byte_is_not_equal() {
        assert!(!constant_time_eq(b"tokem", b"token"));
        assert!(!constant_time_eq(b"t0ken", b"token"));
    }
}
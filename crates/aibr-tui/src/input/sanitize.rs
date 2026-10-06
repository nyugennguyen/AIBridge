//! URL sanitisation for `Ctrl+Click`-to-open.
//!
//! # WHY THIS IS THE MOST SECURITY-SENSITIVE FUNCTION IN THE SUBSYSTEM
//!
//! A hyperlink in this client does not come from the operator. It comes from a pane's
//! output, which comes from an agent, which came from a peer on the tailnet. Opening
//! a URI from a peer's output means handing the operating system's URL handler a
//! string the peer chose. `file:///…` reads a local file, `javascript:` and `data:`
//! run script in whatever the handler is, and on several platforms the handler is a
//! general command dispatcher whose behaviour depends on the scheme alone.
//!
//! So the rule is an ALLOWLIST OF EXACTLY TWO SCHEMES, applied after the string has
//! been normalised, and it is applied here -- once -- rather than in each of the
//! places that can produce a URI. A peer that emits `HTTP://`, `hTtP:`, or `http:`
//! with a leading space gets the same treatment as `https://`, because the scheme is
//! lowercased and the string is trimmed before it is compared, and a peer that emits
//! `http://host/\nrm -rf ~` is refused outright because a control character in a URI
//! is either a header-injection attempt or a parser-differential attempt.
//!
//! The two escapes that this specifically closes, because both are real: a backslash
//! is refused (`http:\\evil` is normalised to `http://evil` by several URL parsers,
//! so accepting backslashes makes the allowlist a suggestion), and any scheme
//! character beyond the RFC 3986 alphabet is refused rather than truncated.

/// A URL that has passed [`sanitize_url`].
///
/// Unconstructible from outside this module: the inner string is private and the
/// only constructor is [`sanitize_url`]. That is what makes
/// [`UrlOpener`](crate::input::UrlOpener) safe to implement -- an implementation
/// cannot be handed a string that skipped validation, because there is no way to
/// build one.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SanitizedUrl(String);

impl SanitizedUrl {
    /// The URL, safe to hand to an opener.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consume and return the inner string.
    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl std::fmt::Display for SanitizedUrl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Why a URL was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlRejection {
    /// Empty, or empty after trimming.
    Empty,
    /// Longer than [`MAX_URL_LENGTH`].
    TooLong(usize),
    /// Contained a control character or a DEL.
    ///
    /// Carries the character, not the URL. A URL comes from a peer's output, and
    /// echoing one into a log or a status bar would route attacker-chosen bytes into
    /// a log file.
    ControlCharacter,
    /// Contained a backslash, which several URL parsers normalise into a slash.
    Backslash,
    /// No `:` separator, so there is no scheme to check.
    NoScheme,
    /// The scheme is syntactically invalid.
    MalformedScheme,
    /// The scheme is well-formed but not `http` or `https`.
    ///
    /// Carries the scheme only, never the rest of the URL.
    SchemeNotAllowed(String),
    /// `http`/`https` with no `//`, e.g. `http:example.com`.
    NotHierarchical,
    /// `http`/`https` with an empty authority.
    NoAuthority,
}

/// Upper bound on an accepted URL.
///
/// 2048 bytes is above every real URL and below the length at which a status-bar
/// echo would be truncated anyway.
pub const MAX_URL_LENGTH: usize = 2048;

/// Validate a URI from a pane and return it if, and only if, it is safe to open.
///
/// # Errors
///
/// Returns the specific [`UrlRejection`] rather than a boolean, because the caller
/// shows the operator WHY a link did not open, and "that link was refused" is a
/// useless message when the actual answer is "it used the `file` scheme".
pub fn sanitize_url(raw: &str) -> Result<SanitizedUrl, UrlRejection> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(UrlRejection::Empty);
    }
    if trimmed.chars().count() > MAX_URL_LENGTH {
        return Err(UrlRejection::TooLong(trimmed.chars().count()));
    }
    if trimmed.chars().any(|character| character.is_control()) {
        return Err(UrlRejection::ControlCharacter);
    }
    // Checked before the scheme, because a backslash in the authority is what makes
    // `http:\evil.example` parse as `http://evil.example` in a lenient parser.
    if trimmed.contains('\\') {
        return Err(UrlRejection::Backslash);
    }

    let colon = trimmed.find(':').ok_or(UrlRejection::NoScheme)?;
    let scheme = &trimmed[..colon];
    if !is_valid_scheme(scheme) {
        return Err(UrlRejection::MalformedScheme);
    }
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(UrlRejection::SchemeNotAllowed(scheme));
    }

    let rest = &trimmed[colon + 1..];
    let Some(authority_and_path) = rest.strip_prefix("//") else {
        return Err(UrlRejection::NotHierarchical);
    };
    let authority = authority_and_path
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if authority.is_empty() {
        return Err(UrlRejection::NoAuthority);
    }

    // Reassembled rather than returned as `trimmed`: the scheme is lowercased and the
    // surrounding whitespace is gone, so what the opener receives is the exact form
    // that was validated rather than something close to it.
    Ok(SanitizedUrl(format!("{scheme}://{authority_and_path}")))
}

/// RFC 3986 `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`.
fn is_valid_scheme(scheme: &str) -> bool {
    let mut characters = scheme.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'))
}

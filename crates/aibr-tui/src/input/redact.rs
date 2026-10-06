//! Secret redaction on the way out of the client.
//!
//! # WHY THE CLIENT REDACTS AT ALL
//!
//! Criteria 7 and 8 are about text leaving the client: a copied selection, a yanked
//! line, a raw log. A pane's grid is not the client's to sanitise -- it renders what
//! the agent printed, and the client has no way to know which part of a diff is a
//! secret without parsing the diff. The only boundary where the client CAN enforce
//! the property is the moment text crosses out of it, so that is where redaction
//! happens, and it happens on EVERY such path including the ones that feel harmless.
//!
//! # WHY THE PRODUCTION IMPLEMENTATION IS NOT IN THIS FILE
//!
//! The canonical rules are the engine's -- `src/` owns the redaction the TypeScript
//! daemon applies to job output, and Phase 6's telemetry self-audit asserts the two
//! agree. A second, weaker implementation here would be a rule set that passes its own
//! tests and disagrees with the daemon's on any input the author did not consider.
//!
//! What is in this file is therefore a GENEROUS fail-closed default, not a competing
//! rule set: it over-redacts rather than under-redacts, because a selection that came
//! out with a few extra characters masked is a minor inconvenience and a selection
//! that came out with a live token in it is the failure the criterion names. It exists
//! so that a client built before the real redactor lands cannot copy a raw secret, and
//! integration replaces it with `#[derive(Default)] struct EngineRedactor;` over the
//! shared rules.
//!
//! The [`Redactor`] trait exists so that replacement is a type swap in one field, not
//! a search through the engine.

use crate::input::traits::Redactor;

/// Redaction rules that mask conservatively.
///
/// NOT A PRODUCTION REDACTOR. See the module header.
#[derive(Debug, Clone, Copy, Default)]
pub struct ConservativeRedactor;

/// One masked region, used by the tests to assert WHAT was masked rather than that
/// something changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mask {
    /// The character offset in the input where the mask begins.
    pub start: usize,
    /// How many characters were replaced.
    pub length: usize,
}

/// What the replacement text is.
///
/// Fixed rather than a scheme (`[redacted]`, `***`, `REDACTED`) so that a masked
/// secret cannot be recovered by its length. A fixed-width mask leaks the length of
/// the secret, which for a bearer token is a meaningful fraction of the entropy.
const MASK: &str = "[redacted]";

impl Redactor for ConservativeRedactor {
    fn redact(&self, text: &str) -> String {
        let (redacted, _) = redact_with_report(text);
        redacted
    }
}

/// Text that has been through a [`Redactor`].
///
/// CRATE-PRIVATE CONSTRUCTOR, deliberately. This is the one place where a type-level
/// invariant is cheaper than a review comment: criteria 7 and 8 say no secret reaches
/// the clipboard, and a `String` in an `Action` variant would make that a promise
/// about every future caller rather than a fact. With this type the compiler enforces
/// it for callers outside the crate, and inside the crate the only constructors are
/// the two functions that redact first.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RedactedText(String);

impl RedactedText {
    /// Wrap text that a [`Redactor`] has already processed.
    ///
    /// Crate-private on purpose; see the type's documentation.
    #[must_use]
    pub(crate) fn new(redacted: String) -> Self {
        Self(redacted)
    }

    /// The text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consume and return the text.
    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

/// Redact and wrap, in one step, so no caller can forget the first half.
#[must_use]
pub fn redact_to_text(redactor: &dyn Redactor, text: &str) -> RedactedText {
    RedactedText::new(redactor.redact(text))
}

/// Redact, and report what was masked.
///
/// The report exists for the tests. A redaction function whose only observable output
/// is "the string changed" cannot be tested against a case where it changed the WRONG
/// thing, which is the failure a redactor actually has.
#[must_use]
pub fn redact_with_report(text: &str) -> (String, Vec<Mask>) {
    let mut masks = Vec::new();
    let mut out = String::with_capacity(text.len());
    let bytes: Vec<char> = text.chars().collect();
    let mut index = 0;

    while index < bytes.len() {
        if let Some((offset, length)) = match_at(&bytes, index) {
            let start = index + offset;
            // The characters BEFORE the mask are emitted rather than dropped. A private-path
            // rule matches at `/Users/` and masks from the user name on, so the prefix is part
            // of the match and part of the output: dropping it would turn `/Users/alice/x`
            // into `[redacted]` and make the copied path unusable.
            out.extend(bytes[index..start].iter());
            masks.push(Mask { start, length });
            out.push_str(MASK);
            index = start + length;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    (out, masks)
}

/// The span a matcher claims: `(offset from the match index, length)`.
///
/// THE OFFSET IS NOT ALWAYS ZERO. A private-path match starts at `/Users/` but must mask
/// only the user segment, so it reports an offset past the prefix. A single
/// `(offset, length)` is enough for every rule here; a matcher that needed a non-contiguous
/// span would be masking something that is not a secret.
type Span = (usize, usize);

/// The span of the secret starting at `index`, if one starts here.
///
/// Order matters and is not alphabetical: the more specific patterns run first
/// because a generic high-entropy run would otherwise match the tail of a
/// `Bearer sk-…` and leave the `Bearer sk-` prefix readable.
fn match_at(text: &[char], index: usize) -> Option<Span> {
    if let Some(length) = match_keyword_bearer(text, index) {
        return Some(length);
    }
    if let Some(length) = match_assignment(text, index) {
        return Some(length);
    }
    if let Some(length) = match_url_credentials(text, index) {
        return Some(length);
    }
    if let Some(length) = match_home_path(text, index) {
        return Some(length);
    }
    match_token(text, index)
}

/// `Bearer sk-…`, `token: …`, `api_key = …` -- a named secret and its value.
///
/// THE PRECEDING-CHARACTER GUARD IS LOAD-BEARING. Without it, `csrftoken = abc123` matches
/// on `token` and every CSRF field in a debug dump becomes `[redacted]` -- which is how an
/// over-eager redaction rule gets switched off by an operator, and an off redaction rule
/// leaks everything the rule was for. A match is refused when the character before the
/// keyword is alphanumeric, so `csrftoken` and `mytoken` are field names and `token` and
/// `X-Token` are not. An underscore is ALLOWED before the keyword, because `API_KEY` is a
/// name that means what it says.
fn match_keyword_bearer(text: &[char], index: usize) -> Option<Span> {
    // TWO LISTS, BECAUSE THE SEPARATOR RULE DIFFERS.
    //
    // `Authorization: Bearer <token>` and `Basic <credentials>` put a SPACE between the
    // keyword and the secret, so a separator is optional for them. `token: <v>`,
    // `api_key=<v>` and `password = <v>` require one, or ordinary prose would match:
    // "the password is required in production" must not have "is" masked.
    //
    // Only the AUTHORIZATION keywords accept a bare space, and they additionally require a
    // value of at least `MIN_VALUE` characters, so "basic auth" in a sentence is left alone.
    const AUTHORIZATION: [&str; 2] = ["bearer", "basic"];
    const ASSIGNED: [&str; 4] = ["token", "apikey", "api_key", "password"];

    if preceded_by_identifier(text, index) {
        return None;
    }
    // The matched keyword's length, which is what steps the cursor past it.
    let matched: Option<usize> = AUTHORIZATION
        .iter()
        .find(|keyword| starts_with_ignore_case(text, index, keyword))
        .map(|keyword| keyword.chars().count())
        .or_else(|| {
            ASSIGNED
                .iter()
                .find(|keyword| starts_with_ignore_case(text, index, keyword))
                .map(|keyword| keyword.chars().count())
        });
    let keyword_len = matched?;
    // Only an authorization keyword accepts a bare space; see the doc comment.
    let authorization = AUTHORIZATION
        .iter()
        .any(|keyword| keyword.chars().count() == keyword_len);
    let mut cursor = index + keyword_len;
    // Whitespace before the separator is tolerated, because `api_key = value` is as common
    // as `api_key=value` and a rule that only catches one of them is a rule with a hole.
    let after_space = skip_spaces(text, cursor);
    match text.get(after_space) {
        Some(':') | Some('=') => cursor = after_space + 1,
        _ if authorization
            && matches!(text.get(cursor), Some(character) if character.is_whitespace()) => {}
        _ => return None,
    }
    let value_start = skip_spaces(text, cursor);
    let length = value_end(text, value_start);
    // The minimum length is what keeps `Bearer` followed by a word in prose from masking
    // that word. Real bearer tokens and credentials are far longer.
    if length - value_start < MIN_VALUE {
        return None;
    }
    Some((0, length - index))
}

/// Shortest value a keyworded secret is allowed to have.
///
/// Below this, "bearer auth" in a sentence would have "auth" masked, and a rule that masks
/// ordinary words is a rule the operator disables.
const MIN_VALUE: usize = 8;

/// `KEY=value`, `TOKEN=value`, `SECRET=value` in an environment dump.
fn match_assignment(text: &[char], index: usize) -> Option<Span> {
    const NAMES: [&str; 6] = ["token", "secret", "password", "passwd", "api_key", "apikey"];
    let name = NAMES
        .iter()
        .find(|name| starts_with_ignore_case(text, index, name))?;
    let mut cursor = index + name.chars().count();
    if preceded_by_identifier(text, index) {
        return None;
    }
    while matches!(text.get(cursor), Some(character) if character.is_alphanumeric() || *character == '_')
    {
        cursor += 1;
    }
    cursor = skip_spaces(text, cursor);
    if text.get(cursor) != Some(&'=') {
        return None;
    }
    cursor += 1;
    let value_start = skip_spaces(text, cursor);
    let length = value_end(text, value_start);
    (length - value_start >= MIN_VALUE).then_some((0, length - index))
}

/// `https://user:password@host` -- credentials in a URL a pane printed.
fn match_url_credentials(text: &[char], index: usize) -> Option<Span> {
    const SCHEMES: [&str; 2] = ["http://", "https://"];
    let scheme = SCHEMES
        .iter()
        .find(|scheme| starts_with_ignore_case(text, index, scheme))?;
    let mut cursor = index + scheme.chars().count();
    let at = cursor;
    while matches!(text.get(cursor), Some(character) if *character != '@' && !character.is_whitespace())
    {
        cursor += 1;
    }
    if text.get(cursor) != Some(&'@') || cursor == at {
        return None;
    }
    // Mask the whole authority up to the `@`: the username is a secret too often
    // enough, and the host is recoverable from the rest of the line.
    Some((0, cursor + 1 - index))
}

/// `/Users/<name>/…` and `/home/<name>/…` -- the operator's own user name.
///
/// Criteria 7 and 8 name private paths alongside tokens. A terminal that copies
/// `/Users/alice/.ssh/id_ed25519` to a clipboard the operator then pastes into a public
/// issue has leaked both a home directory and a filename.
///
/// ONLY THE USER SEGMENT IS MASKED, so the output stays useful: `/Users/[redacted]/.ssh/
/// id_ed25519` still tells the operator which file it was. Masking the whole path would
/// make a copied command unrunnable, and an operator who cannot use a redaction's output
/// turns it off.
///
/// A path with no user segment is not a home directory: `/home/` alone is a directory
/// listing, and masking it would break ordinary output.
fn match_home_path(text: &[char], index: usize) -> Option<Span> {
    const PREFIXES: [&str; 3] = ["/Users/", "/home/", "/root/"];
    let prefix = PREFIXES
        .iter()
        .find(|prefix| starts_with(text, index, prefix))?;
    let mut cursor = index + prefix.chars().count();
    while matches!(text.get(cursor), Some(character) if character.is_alphanumeric() || matches!(character, '.' | '-' | '_'))
    {
        cursor += 1;
    }
    // ONLY THE USER SEGMENT, so the output stays runnable: `/Users/[redacted]/.ssh/…`.
    // That is why the offset exists: the match starts at `/` and the mask goes after it.
    let offset = prefix.chars().count();
    let user_start = index + offset;
    (cursor > user_start).then_some((offset, cursor - user_start))
}

/// Whether the character before `index` makes this a WORD rather than a name.
///
/// `_` is allowed through, so `OPENAI_API_KEY` still matches on `API_KEY`; a letter or
/// digit is not, so `csrftoken` and `mytoken` are field names rather than secrets named
/// `token`.
fn preceded_by_identifier(text: &[char], index: usize) -> bool {
    index > 0 && text[index - 1].is_alphanumeric()
}

/// A bare high-entropy token: at least 24 characters from the token alphabet, with
/// at least one digit, one lowercase and one uppercase.
///
/// The three-character-class requirement is what keeps ordinary prose and every
/// identifier in a stack trace out of the mask. A run of 24 mixed-case characters
/// containing no digit is far more likely to be a class name or a base64 hash of
/// something non-secret than a credential, and masking it would make the default
/// redactor unusable in practice -- which is how operators turn redaction off.
fn match_token(text: &[char], index: usize) -> Option<Span> {
    const MIN_TOKEN: usize = 24;
    let mut cursor = index;
    let (mut upper, mut lower, mut digit) = (false, false, false);
    while let Some(character) = text.get(cursor) {
        if character.is_ascii_alphanumeric()
            || matches!(character, '-' | '_' | '+' | '/' | '=' | '.')
        {
            upper |= character.is_ascii_uppercase();
            lower |= character.is_ascii_lowercase();
            digit |= character.is_ascii_digit();
            cursor += 1;
        } else {
            break;
        }
    }
    let length = cursor - index;
    (length >= MIN_TOKEN && upper && lower && digit).then_some((0, length))
}

/// End of a value: up to the next whitespace, so a whole token goes rather than part
/// of one.
fn value_end(text: &[char], start: usize) -> usize {
    let mut cursor = start;
    while matches!(text.get(cursor), Some(character) if !character.is_whitespace()) {
        cursor += 1;
    }
    cursor
}

fn skip_spaces(text: &[char], mut cursor: usize) -> usize {
    while matches!(text.get(cursor), Some(' ') | Some('\t')) {
        cursor += 1;
    }
    cursor
}

fn starts_with(text: &[char], index: usize, prefix: &str) -> bool {
    prefix
        .chars()
        .enumerate()
        .all(|(offset, character)| text.get(index + offset) == Some(&character))
}

fn starts_with_ignore_case(text: &[char], index: usize, prefix: &str) -> bool {
    prefix.chars().enumerate().all(|(offset, character)| {
        text.get(index + offset)
            .is_some_and(|found| found.eq_ignore_ascii_case(&character))
    })
}

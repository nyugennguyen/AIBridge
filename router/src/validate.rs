//! The structural gate: everything this crate is allowed to reject a request for.
//!
//! ADR 0008 §2.2 assigns Tier 1 exactly this list — presence, type, enum
//! membership, size bounds, unknown-key rejection, format, `job_id` charset, and
//! `project_dir` realpath containment — and states that it is a **rejection
//! filter**. The distinction is not rhetorical and it is enforced in the shape of
//! this module: every public function here returns either a validated value or an
//! [`ApiError`]. None of them returns a verdict about whether a caller is
//! permitted anything. A structural gate cannot express "allow", and the absence
//! of a way to say so is the mechanism.
//!
//! # The four findings this module closes at ingress
//!
//! | ID | Finding | Here |
//! | --- | --- | --- |
//! | `F-01` | `job_id` becomes a path via `join(dir, id + ".json")` | [`valid_job_id`] |
//! | `F-04` | lexical `resolve()`, no `realpath` | [`canonical_project_dir`] |
//! | `F-06` | unversioned legacy state | [`envelope`] |
//! | `F-03` | `GET /jobs/:id` has no authentication | [`crate::auth`], applied in [`crate::routes`] |
//!
//! # The one judgement call: what `schemaVersion` means on the wire
//!
//! `contracts/v1/trigger-request.schema.json` does not carry a `schemaVersion`
//! field, and its generated Rust type is `#[serde(deny_unknown_fields)]`. The
//! contracts cannot be edited — they are generated from Zod, and Zod is owned by
//! `src/` — so the version cannot be added to the payload type. It is therefore an
//! **envelope key alongside the payload**, not a field inside it:
//!
//! ```json
//! { "schemaVersion": "v1", "source_agent_id": "...", "target_agent_id": "...", ... }
//! ```
//!
//! [`envelope`] requires the key, requires it to be a string, requires it to equal
//! this binary's [`crate::CONTRACT_VERSION`], and **removes** it before the
//! remainder is deserialized into the generated type.
//!
//! Removing it is not the "silently strip unknown keys" behaviour ADR 0008 §2.3
//! contrasts the engine's Zod schemas with. The distinction is that this key is
//! *required*: a payload without it is refused with `400`, which is the opposite of
//! stripping. Every other unknown key still reaches `deny_unknown_fields` and is
//! still rejected. What is stripped is one key, after it has been checked, and only
//! because the generated type has nowhere to put it.
//!
//! The alternative — an HTTP header such as `AIBRIDGE-Schema-Version` — was
//! rejected because the version then lives somewhere the payload's own bytes do
//! not, which is what makes it forgettable: a client that logs the body for a bug
//! report and replays the body has silently dropped the one field that says what it
//! meant.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::contracts::TriggerRequest;
use crate::error::ApiError;
use crate::CONTRACT_VERSION;

/// The largest request body the router will buffer.
///
/// 1 048 576 bytes. Not a fresh number: it is the same limit `createApp()` already
/// applies ([`src/server/app.ts:38`](../../src/server/app.ts)),
/// `bodyLimit: 1_048_576`, and the router has to accept exactly what the engine
/// accepts or the migration changes the contract for every existing caller.
///
/// ADR 0008 §2.4 gives the reasoning for the ceiling being *where it is*: the
/// configured job timeout is 1800 s, so even a body at this limit amortises to
/// ~0.55 B/s, and JSON is the only format an operator can inspect with `jq` during
/// an incident. It also means this constant is a memory bound as much as a policy:
/// the router runs under `MemoryMax=32M` (§2.7), so one buffered body must be a
/// small fraction of the whole process.
pub const MAX_BODY_BYTES: usize = 1_048_576;

/// The longest accepted `job_id`, in bytes.
///
/// 128 bytes. The engine mints ids of the form `#<26 lowercase hex chars>`
/// ([`src/jobs/manager.ts`](../../src/jobs/manager.ts)), which leaves 128 as more than
/// an order of magnitude of headroom over anything in production.
///
/// The bound exists so that the charset check is also a length check: a 10 MB string of
/// `-` is a valid member of the charset, and an unbounded id would otherwise be a way
/// to make the router allocate and then carry an arbitrarily long string in a response
/// field.
pub const JOB_ID_MAX_LEN: usize = 128;

/// The `job_id` charset: `[A-Za-z0-9_-]{1,128}`.
///
/// This is the `F-01` closure, and the finding's own reproduction is the test: a
/// schema-valid `../escaped` maps `/state/jobs` to `/state/escaped.json`
/// ([`src/jobs/store.ts:36`](../../src/jobs/store.ts)). The threat model says the
/// schema accepts it because `job_id` is `z.string().min(1)` — *any* nonempty
/// string, including one containing separators and `..`.
///
/// Rejecting the traversal forms by naming them — rejecting `..`, rejecting `/`,
/// rejecting a leading `/` — was the first design and is the wrong one. It is an
/// allowlist with a denylist bolted on, and every denylist entry is one more thing
/// to get right on a platform whose path grammar this module cannot enumerate
/// (`\` on Windows, NUL bytes, `C:` drive letters, trailing dots that some
/// filesystems strip, Unicode normalisation on APFS). The allowlist below has no
/// such list to maintain: every accepted byte is a byte that cannot be a separator,
/// a dot, or anything a filesystem treats specially.
///
/// The cost is a real compatibility break, and it is the right one: an id
/// containing `/` has, by definition, been used as a path, and the entity whose ids
/// those were is being replaced. M7.5's SQLite queue keys on the same charset, so
/// the constraint is imposed once, here, at the outermost boundary, rather than in
/// every consumer of an id.
pub fn valid_job_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= JOB_ID_MAX_LEN
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}

/// Split a validated body into its version envelope and its payload.
///
/// See the module docs for why the version is an envelope key and why removing it
/// is not silent stripping.
pub fn envelope(document: &mut Value) -> Result<(), ApiError> {
    let Some(object) = document.as_object_mut() else {
        return Err(ApiError::InvalidPayload(
            "request body must be a JSON object",
        ));
    };

    // Read first, remove only on success. The removal is unconditional once the
    // version checks out — a `deny_unknown_fields` type has nowhere to put the key —
    // but doing it in two steps means a *refused* document comes back exactly as it
    // arrived. That matters more than it looks: `envelope` is the only function in
    // this crate that mutates the caller's body, and a mutating function whose
    // failure path is also mutating is one that is hard to reason about at the next
    // call site. It also costs nothing, since the success path does the `remove`
    // anyway.
    let Some(value) = object.get("schemaVersion") else {
        // `SF-14`: a missing canonical version is an explicit failure, never an
        // empty state and never an inferred one. Guessing here is what F-06
        // describes — unversioned state that a future reader cannot interpret.
        return Err(ApiError::InvalidPayload(
            "request body requires a schemaVersion",
        ));
    };

    match value {
        Value::String(version) if version == CONTRACT_VERSION => {
            object.remove("schemaVersion");
            Ok(())
        }
        // Both a wrong version and a non-string version land here, deliberately, and
        // together. `{"schemaVersion": 1}` is not a v1 request with a typo in it; it
        // is a caller that does not know what the field is, and the two deserve the
        // same answer.
        _ => Err(ApiError::UnsupportedSchemaVersion),
    }
}

/// Deserialize a body that has already passed [`envelope`].
///
/// The contract types reject unknown keys on their own (291
/// `#[serde(deny_unknown_fields)]` attributes across `contracts.rs`), so this
/// reports failure without reproducing what serde would say: serde's message names
/// the offending key, and a `400` body that names the key a caller invented is
/// more reflection than this crate allows. See [`crate::error`].
pub fn payload<T: DeserializeOwned>(
    document: &Value,
    discriminator: &'static str,
) -> Result<T, ApiError> {
    T::deserialize(document).map_err(|_| ApiError::InvalidPayload(discriminator))
}

/// Check a `job_id` that a contract type has already bounded to "some string".
///
/// Separate from [`valid_job_id`] because the two callers have different
/// vocabularies: this returns [`ApiError::InvalidPayload`] and the path-parameter
/// call site in [`crate::routes`] deliberately does not use it. See that call site
/// for why a malformed id in a URL is a `404` rather than a `400`.
pub fn require_job_id(id: &str, discriminator: &'static str) -> Result<(), ApiError> {
    if valid_job_id(id) {
        Ok(())
    } else {
        Err(ApiError::InvalidPayload(discriminator))
    }
}

/// Canonicalise `requested` and require that it stay inside `roots`.
///
/// # What this is not
///
/// This is **not** [`assertProjectAllowed`](../../src/security/allowlist.ts), and
/// it does not decide allowlist membership. That function answers "is this
/// configured project one this deployment permits" — a policy question whose
/// answer is per-deployment and per-caller. This answers one question, and it is
/// strictly narrower:
///
/// > Does this path, once the filesystem has had its say about symlinks, still lie
/// > inside one of the configured project roots?
///
/// The gap between the two questions is where `F-04` lives. The engine's check is
/// `resolve(candidate.path) === resolve(project_dir)` — purely lexical. A project
/// root containing a symlink to `/etc` produces two paths that are lexically equal
/// to a request naming that symlink and that point at completely different places
/// on disk. Resolving is what closes it.
///
/// # Why this does not become authority by accumulation
///
/// Three properties keep it on the Tier 1 side of the line:
///
/// 1. **It cannot answer "yes, you may use this project."** It answers "this path
///    does not escape the configured roots." A path can pass here and still be
///    refused by the worker for being the wrong project, or the wrong project for
///    this source, or not approved.
/// 2. **It fails identically for every reason.** A non-absolute path, a path that
///    does not exist, and a path that escapes through a symlink all produce
///    [`ApiError::InvalidPayload`] with the same message. A caller cannot use the
///    response to learn which configured roots exist, or whether a particular
///    directory is one of them.
/// 3. **The worker repeats it.** M7.7 re-runs `assertProjectAllowed` with its own
///    `realpath` check at the actual effect boundary, which is the only place where
///    the answer can be acted on without a time-of-check/time-of-use window. This
///    function reduces the garbage that reaches the worker; it does not stand in
///    for it.
///
/// # Why `realpath` and not `canonicalize`
///
/// `std::fs::canonicalize` *is* `realpath(3)` — it resolves symlinks and requires
/// the whole path to exist. `std::path::absolute` would not do, and neither would
/// manual `.`/`..` folding: both are lexical, which is the bug.
///
/// The existence requirement is load-bearing and is why the failure modes above
/// are indistinguishable. `canonicalize` cannot return a path outside the roots for
/// a `project_dir` that resolves, and a `project_dir` that does not resolve cannot
/// be a working directory for any runtime. Rejecting it here is not a policy
/// choice; it is the same answer the worker would give.
pub fn canonical_project_dir(requested: &str, roots: &[PathBuf]) -> Result<PathBuf, ApiError> {
    const REFUSED: &str = "project_dir is not a path inside this deployment's project roots";

    // Absolute only. A relative `project_dir` would be resolved against the
    // router's working directory, which is whatever directory a supervisor
    // happened to start it in — so two nodes running the same binary from
    // different working directories would admit different paths from the same
    // request. Refusing is the only outcome that does not depend on that.
    let candidate = Path::new(requested);
    if !candidate.is_absolute() {
        return Err(ApiError::InvalidPayload(REFUSED));
    }

    let resolved =
        std::fs::canonicalize(candidate).map_err(|_| ApiError::InvalidPayload(REFUSED))?;

    // `starts_with` on `Path` compares whole components, not string prefixes:
    // `/srv/project-evil` does not start with `/srv/project`. That is the property
    // a hand-written `starts_with(&root.to_string_lossy())` would silently lose,
    // and it is the second form of the same bug `F-04` is about.
    let contained = roots
        .iter()
        .any(|root| resolved == *root || resolved.starts_with(root));

    if contained {
        Ok(resolved)
    } else {
        Err(ApiError::InvalidPayload(REFUSED))
    }
}

/// Apply the `job_id` charset gate to a trigger's optional caller-supplied id.
///
/// An `Ok(None)` here is the common case and is **not** an endorsement of the
/// request: it means only that the caller declined to name a job. See
/// [`crate::routes`] for what happens next.
pub fn check_optional_job_id(trigger: &TriggerRequest) -> Result<(), ApiError> {
    match trigger.job_id.as_ref() {
        Some(id) => require_job_id(id, "job_id must match [A-Za-z0-9_-]{1,128}"),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{envelope, valid_job_id, ApiError, CONTRACT_VERSION};
    use serde_json::json;

    /// The literal reproduction from the threat model: `F-01` is that this value
    /// is schema-valid (`z.string().min(1)`) and maps
    /// `/state/jobs` -> `/state/escaped.json`.
    #[test]
    fn f01_the_threat_model_reproduction_is_refused() {
        assert!(!valid_job_id("../escaped"));
        assert!(!valid_job_id(".."));
        assert!(!valid_job_id("../"));
        assert!(!valid_job_id("/etc/passwd"));
        assert!(!valid_job_id("a/b"));
        assert!(!valid_job_id("a\\b"));
        assert!(!valid_job_id("."));
        assert!(!valid_job_id("a\0b"));
    }

    #[test]
    fn valid_job_ids_are_accepted() {
        for id in [
            "a",
            "A",
            "0",
            "-",
            "_",
            "job-1",
            "JOB_1",
            "0123456789abcdef",
        ] {
            assert!(valid_job_id(id), "{id:?} should be accepted");
        }
    }

    #[test]
    fn the_empty_id_is_refused() {
        // `min(1)` in the contract already excludes it; asserting here means the
        // charset gate does not depend on having run the contract first.
        assert!(!valid_job_id(""));
    }

    #[test]
    fn the_charset_is_bounded_at_128_bytes() {
        assert!(valid_job_id(&"a".repeat(128)));
        assert!(!valid_job_id(&"a".repeat(129)));
    }

    #[test]
    fn f06_a_missing_schema_version_is_refused() {
        let mut document = json!({ "source_agent_id": "test-vps" });
        assert!(matches!(
            envelope(&mut document),
            Err(ApiError::InvalidPayload(_))
        ));
    }

    #[test]
    fn f06_an_unknown_schema_version_is_refused_and_not_coerced() {
        let mut document = json!({ "schemaVersion": "v2", "source_agent_id": "test-vps" });
        assert_eq!(
            envelope(&mut document),
            Err(ApiError::UnsupportedSchemaVersion)
        );
        // The body is untouched: a refused version leaves no half-migrated object
        // behind for a caller that retries with a corrected version by mutating
        // what it thinks it sent.
        assert_eq!(document["schemaVersion"], json!("v2"));
    }

    #[test]
    fn a_non_string_schema_version_is_refused() {
        for version in [
            json!(1),
            json!(null),
            json!(true),
            json!(["v1"]),
            json!({ "v": 1 }),
        ] {
            let mut document = json!({ "schemaVersion": version });
            assert_eq!(
                envelope(&mut document),
                Err(ApiError::UnsupportedSchemaVersion),
                "{version} should be refused"
            );
        }
    }

    #[test]
    fn a_matching_schema_version_is_removed_for_the_payload_type() {
        let mut document =
            json!({ "schemaVersion": CONTRACT_VERSION, "source_agent_id": "test-vps" });
        assert_eq!(envelope(&mut document), Ok(()));
        assert!(
            document.get("schemaVersion").is_none(),
            "the envelope key must be gone before `deny_unknown_fields` sees it"
        );
        assert_eq!(document["source_agent_id"], json!("test-vps"));
    }

    #[test]
    fn every_other_unknown_key_survives_to_be_rejected() {
        // The property that makes removing `schemaVersion` safe: it is the *only*
        // key taken. If this fails, the router has started stripping unknown keys,
        // which is precisely the engine's weaker behaviour ADR 0008 §2.3 says not
        // to copy.
        let mut document = json!({
            "schemaVersion": CONTRACT_VERSION,
            "source_agent_id": "test-vps",
            "__aibr_unknown_key__": true,
        });
        assert_eq!(envelope(&mut document), Ok(()));
        assert!(
            document.get("__aibr_unknown_key__").is_some(),
            "an unknown key other than the envelope key must reach the contract type"
        );
    }
}

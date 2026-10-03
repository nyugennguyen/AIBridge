//! The four structural gates, one test per finding, plus the boundary assertions.
//!
//! Naming follows the threat model
//! ([`Docs/security/milestone-0-threat-model.md`](../../Docs/security/milestone-0-threat-model.md)),
//! so a reviewer checking whether `F-01` is closed reads the finding's own
//! reproduction rather than a paraphrase of it. Where a doc comment exists it is
//! about *why that assertion is the right one* — the part a later contributor needs
//! and the part a `cargo test` run cannot tell them.

mod support;

use std::path::Path;

use axum::http::StatusCode;
use serde_json::{json, Value};

use support::{app, authorized, bearer, config_json, oneshot, request, TempDir, TOKEN};

// ---------------------------------------------------------------------------
// F-01: job_id -> join(directory, job.id + ".json")
// ---------------------------------------------------------------------------

/// `F-01`'s reproduction, on the route that carries a caller-supplied `job_id`.
///
/// The threat model is exact: "`config/schemas.ts` accepts nonempty `job_id`;
/// `jobs/store.ts` uses `join(directory, job.id + \".json\")`. A schema-valid
/// `../escaped` maps `/state/jobs` to `/state/escaped.json`."
///
/// The value below is the literal string from the finding and it *is* schema-valid
/// under the current contract (`z.string().min(1)` accepts it). If this test ever
/// passes for some reason other than the charset gate, the likely cause is that
/// `triggerRequestSchema` gained a `job_id` pattern in Zod and the generated type
/// started rejecting it upstream — at which point this test has stopped testing the
/// router and should be replaced by one that does.
#[tokio::test]
async fn f01_a_traversal_job_id_is_refused_on_trigger() {
    let root = TempDir::new("f01-trigger");
    let mut trigger = support::valid_trigger(root.path());
    trigger["job_id"] = json!("../escaped");

    let reply = oneshot(app(root.path()), authorized("POST", "/trigger", trigger)).await;

    assert_eq!(
        reply.status,
        StatusCode::BAD_REQUEST,
        "body was {}",
        reply.text()
    );
}

/// `F-01` from the other direction: a peer's report naming a traversal `job_id`.
///
/// A separate route and a separate code path. `trigger` validates an *optional*
/// field; `report` validates a *required* one, so the two are not the same check and
/// a fix applied to one has no reason to cover the other.
#[tokio::test]
async fn f01_a_traversal_job_id_is_refused_on_report() {
    let root = TempDir::new("f01-report");
    let mut report = support::valid_report();
    report["job_id"] = json!("../../etc/passwd");

    let reply = oneshot(app(root.path()), authorized("POST", "/report", report)).await;

    assert_eq!(
        reply.status,
        StatusCode::BAD_REQUEST,
        "body was {}",
        reply.text()
    );
}

/// `F-01` on the read route — the one that had no authentication at all.
///
/// The status is `404` rather than `400`, and the test asserts `404` specifically.
/// That is not a weaker claim: this route answers `404` to *everything* (see
/// `the_job_read_route_answers_not_found_for_every_id`), so the assertion is that a
/// traversal id produces the same answer as a well-formed one. There is no route on
/// which this id reaches a filesystem, and there will not be one when M7.7 wires the
/// store, because the gate is in front of it.
#[tokio::test]
async fn f01_a_traversal_job_id_in_a_path_is_never_a_job() {
    let root = TempDir::new("f01-read");

    // `..%2Fescaped` and `%2e%2e%2fescaped` are the same traversal with different
    // encodings. They are in the table because a gate that checked the *decoded*
    // path correctly still has to reject both, and one that checked the raw segment
    // would only accidentally reject the unencoded form.
    for traversal in ["../escaped", "..%2Fescaped", "a%2Fb", "%2e%2e%2fescaped"] {
        let reply = oneshot(
            app(root.path()),
            authorized("GET", &format!("/jobs/{traversal}"), json!(null)),
        )
        .await;

        assert_eq!(
            reply.status,
            StatusCode::NOT_FOUND,
            "{traversal:?} produced {}, which is not the only answer this route is \
             allowed to give",
            reply.status
        );
    }
}

/// A well-formed `job_id` is admitted, so the charset is not simply refusing
/// everything.
///
/// Without this, "refuse all ids" and "refuse traversal ids" are the same test
/// suite, and a router that rejected every `job_id` would pass every `F-01` test
/// above. That failure is not hypothetical: it is what a `deny_unknown_fields`
/// regression or a routing typo produces, and it is invisible unless something
/// asserts the positive.
#[tokio::test]
async fn a_charset_conforming_job_id_is_admitted() {
    let root = TempDir::new("f01-positive");
    let mut trigger = support::valid_trigger(root.path());
    trigger["job_id"] = json!("job_1-A-b");

    let reply = oneshot(app(root.path()), authorized("POST", "/trigger", trigger)).await;

    assert_eq!(
        reply.status,
        StatusCode::ACCEPTED,
        "body was {}",
        reply.text()
    );
    assert_eq!(reply.json()["job_id"], json!("job_1-A-b"));
    assert_eq!(reply.json()["accepted"], json!(true));
}

/// The `202` echoes a `job_id` the router minted, and that minted id is itself inside
/// the charset.
///
/// The minted value is a correlation token in M7.3 and a real key in M7.5. If the
/// encoder ever emitted a `/`, the `F-01` gate would refuse the router's *own*
/// output the moment a store existed behind it — a self-inflicted regression that no
/// `F-01` test above would catch, because they all use attacker-chosen ids.
#[tokio::test]
async fn a_minted_job_id_is_echoed_and_respects_the_charset() {
    let root = TempDir::new("f01-minted");

    let reply = oneshot(
        app(root.path()),
        authorized("POST", "/trigger", support::valid_trigger(root.path())),
    )
    .await;

    assert_eq!(
        reply.status,
        StatusCode::ACCEPTED,
        "body was {}",
        reply.text()
    );
    let body = reply.json();
    let job_id = body["job_id"].as_str().expect("a string job_id");

    assert_eq!(job_id.len(), 32, "16 bytes hex-encoded: {job_id:?}");
    assert!(
        job_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric()),
        "a minted id must be inside the F-01 charset: {job_id:?}"
    );
    assert_eq!(
        body["status_url"],
        json!(format!("http://router-test.tailnet:8787/jobs/{job_id}"))
    );
}

// ---------------------------------------------------------------------------
// F-03: GET /jobs/:id has no authentication
// ---------------------------------------------------------------------------

/// The closure of `F-03`, in the finding's own words.
///
/// "Legacy job query discloses complete trigger without route authentication (High).
/// `server/routes/jobs.ts` returns `getJob(id)`; `server/app.ts` registers no global
/// auth hook. The record includes prompt, path, source and callback metadata."
///
/// The threat model's acceptance criterion is "`F-01` through `F-04` and `F-06` are
/// demonstrably closed at ingress, with the reproductions ... as the acceptance
/// corpus", so this is the reproduction: the read route, no credentials.
#[tokio::test]
async fn f03_the_job_read_route_refuses_an_unauthenticated_request() {
    let root = TempDir::new("f03");

    let reply = oneshot(
        app(root.path()),
        request("GET", "/jobs/job-1", Some(json!(null)), None),
    )
    .await;

    assert_eq!(
        reply.status,
        StatusCode::UNAUTHORIZED,
        "GET /jobs/:id answered {} with no Authorization header.\n\
         This is F-03. The engine registers this route with no authentication at all \
         (src/server/app.ts:38), and the record it returns carries prompt text, an \
         absolute project path, the source agent id and callback metadata.",
        reply.status
    );
}

/// And it carries the challenge header, so a client knows what to send.
///
/// A `401` without `WWW-Authenticate` closes the disclosure and breaks the contract:
/// the client cannot discover the scheme without reading the engine's source.
#[tokio::test]
async fn f03_the_unauthenticated_refusal_carries_www_authenticate() {
    let root = TempDir::new("f03-challenge");

    let reply = oneshot(
        app(root.path()),
        request("GET", "/jobs/job-1", Some(json!(null)), None),
    )
    .await;

    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    assert!(
        reply.headers.contains_key("www-authenticate"),
        "a 401 without WWW-Authenticate leaves the client guessing the scheme; \
         headers were {:?}",
        reply.headers
    );
}

/// Every route is authenticated. Reads included.
///
/// `F-03` exists because a read route was left unauthenticated on the reasoning that
/// reads are harmless. This test is that reasoning inverted into an assertion over all
/// four routes, so "reads are exempt" cannot be reintroduced by adding a route and
/// forgetting a line.
#[tokio::test]
async fn f03_no_route_answers_without_a_bearer() {
    let root = TempDir::new("f03-all-routes");

    let routes: Vec<(&str, &str, Value)> = vec![
        ("GET", "/health", json!(null)),
        ("POST", "/trigger", support::valid_trigger(root.path())),
        ("GET", "/jobs/job-1", json!(null)),
        ("POST", "/report", support::valid_report()),
    ];

    for (method, path, body) in routes {
        let reply = oneshot(app(root.path()), request(method, path, Some(body), None)).await;

        assert_eq!(
            reply.status,
            StatusCode::UNAUTHORIZED,
            "{method} {path} answered {} without a bearer; body was {}",
            reply.status,
            reply.text()
        );
    }
}

// ---------------------------------------------------------------------------
// F-04: lexical resolve(), no realpath
// ---------------------------------------------------------------------------

/// `F-04`'s reproduction: a symlink inside a configured project root pointing out of
/// it.
///
/// The engine's check is `resolve(candidate.path) === resolve(project_dir)`
/// ([`src/security/allowlist.ts:6`](../../src/security/allowlist.ts)) — purely
/// lexical. For the request below the *lexical* comparison succeeds: the path
/// `<root>/escape` is under `<root>`, character for character. Only `realpath`
/// reveals that it lands outside every configured root.
///
/// The escape target is a sibling directory of the scratch root rather than `/etc`:
/// the assertion is about the resolution, not about reaching a sensitive place, and a
/// test that reads `/etc` to prove a point is a test that could surprise somebody
/// later.
#[tokio::test]
async fn f04_a_symlink_escaping_the_configured_root_is_refused() {
    let scratch = TempDir::new("f04");
    let project = scratch.dir(scratch.path().join("project"));
    let outside = scratch.dir(scratch.path().join("outside"));
    scratch.symlink("escape", &outside);

    let escaping = json!({
        "schemaVersion": "v1",
        "source_agent_id": "some-source-that-is-not-configured",
        "target_agent_id": "router-test",
        "capability": "testing",
        "project_dir": project.join("escape").to_string_lossy(),
        "prompt": "do the thing",
        "callback_url": "http://peer.tailnet:8787/report",
        "timeout_seconds": 600
    });

    let reply = oneshot(
        aibr_router::routes::build(support::state(&project)),
        authorized("POST", "/trigger", escaping),
    )
    .await;

    assert_eq!(
        reply.status,
        StatusCode::BAD_REQUEST,
        "a symlink out of the configured project root was admitted; body was {}\n\
         This is F-04. The engine's assertProjectAllowed compares path.resolve() \
         outputs, which for this request are lexically equal and point at different \
         places on disk.",
        reply.text()
    );
}

/// The positive case: a real subdirectory of the configured root is admitted.
///
/// Without this, "refuse everything" passes the test above.
#[tokio::test]
async fn f04_a_real_subdirectory_of_the_configured_root_is_admitted() {
    let scratch = TempDir::new("f04-positive");
    let project = scratch.dir(scratch.path().join("project"));
    let inside = scratch.dir(project.join("src"));

    let mut trigger = support::valid_trigger(&inside);
    trigger["project_dir"] = json!(inside.to_string_lossy());

    let reply = oneshot(
        aibr_router::routes::build(support::state(&project)),
        authorized("POST", "/trigger", trigger),
    )
    .await;

    assert_eq!(
        reply.status,
        StatusCode::ACCEPTED,
        "body was {}",
        reply.text()
    );
}

/// A path outside every configured root is refused, and the refusal says nothing
/// about *why*.
///
/// The second half is what keeps this Tier 1. A caller must not be able to
/// distinguish "this project is not configured here" from "this path is malformed"
/// from "this path escapes through a symlink" — each is a fact about the deployment's
/// configuration, and a Tier 1 router that discloses them is an oracle for Tier 2's
/// allowlist. All five cases below produce one byte-identical body.
#[tokio::test]
async fn f04_every_containment_failure_produces_one_indistinguishable_answer() {
    let scratch = TempDir::new("f04-indistinguishable");
    let project = scratch.dir(scratch.path().join("project"));
    let outside = scratch.dir(scratch.path().join("outside"));
    scratch.symlink("escape", &outside);

    let cases: Vec<(&str, String)> = vec![
        (
            "escapes via symlink",
            project.join("escape").to_string_lossy().into_owned(),
        ),
        ("outside every root", outside.to_string_lossy().into_owned()),
        // A sibling whose name *starts with* a root's name. `Path::starts_with`
        // compares whole components, so this is refused; a hand-rolled
        // `starts_with(root.to_string_lossy())` would admit it. The second form of
        // the same bug F-04 is about.
        (
            "lexical sibling prefix",
            format!("{}-evil", project.display()),
        ),
        ("relative", "project/src".to_owned()),
        (
            "does not exist",
            project.join("nope").to_string_lossy().into_owned(),
        ),
    ];

    let mut bodies: Vec<Value> = Vec::new();
    for (label, project_dir) in &cases {
        let mut trigger = support::valid_trigger(&project);
        trigger["project_dir"] = json!(project_dir);

        let reply = oneshot(
            aibr_router::routes::build(support::state(&project)),
            authorized("POST", "/trigger", trigger),
        )
        .await;

        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{label} ({project_dir}) was not refused; body was {}",
            reply.text()
        );
        bodies.push(reply.json());
    }

    // The whole document, not one field: a `details` array listing the offending path
    // would pass a single-field check and defeat the property.
    for body in &bodies[1..] {
        assert_eq!(
            body, &bodies[0],
            "two containment failures produced different bodies, which discloses \
             something about the deployment's configuration to a Tier 1 caller"
        );
    }
}

// ---------------------------------------------------------------------------
// F-06: unversioned legacy state
// ---------------------------------------------------------------------------

/// `F-06`: "Unversioned/corrupt legacy state can lose or invent safety evidence
/// (High)", with the milestone's own note that "M7.3 closes the ingress half by
/// stamping and refusing `schemaVersion`".
///
/// The version is refused, not coerced. `SF-14` requires "explicit
/// failure/quarantine, not empty state, silent downgrade, skipped evidence", so a v2
/// payload is not read as v1 with the unknown bits ignored.
#[tokio::test]
async fn f06_an_unknown_schema_version_is_refused() {
    let root = TempDir::new("f06-unknown");
    let mut trigger = support::valid_trigger(root.path());
    trigger["schemaVersion"] = json!("v2");

    let reply = oneshot(app(root.path()), authorized("POST", "/trigger", trigger)).await;

    assert_eq!(
        reply.status,
        StatusCode::BAD_REQUEST,
        "a v2 payload was not refused; body was {}",
        reply.text()
    );
    assert!(
        reply.json()["error"]
            .as_str()
            .expect("an error string")
            .contains("schemaVersion"),
        "the refusal must name the field it refused or an operator cannot act on it; \
         body was {}",
        reply.text()
    );
}

/// A **missing** version is refused too.
///
/// `SF-14` says "unknown/missing". The missing case is the one that is easy to get
/// wrong by accident: an extractor that reads `schemaVersion` as `Option` and treats
/// `None` as "no opinion" admits every unversioned payload, which is exactly the
/// unversioned legacy state `F-06` is about.
#[tokio::test]
async fn f06_a_missing_schema_version_is_refused() {
    let root = TempDir::new("f06-missing");
    let mut trigger = support::valid_trigger(root.path());
    trigger
        .as_object_mut()
        .expect("an object")
        .remove("schemaVersion");

    let reply = oneshot(app(root.path()), authorized("POST", "/trigger", trigger)).await;

    assert_eq!(
        reply.status,
        StatusCode::BAD_REQUEST,
        "an unversioned payload was admitted; body was {}",
        reply.text()
    );
}

/// The version gate covers `report` too. `F-06` is about state, and a report is how a
/// peer asserts that state happened.
#[tokio::test]
async fn f06_the_version_gate_covers_report_as_well() {
    let root = TempDir::new("f06-report");
    let mut report = support::valid_report();
    report
        .as_object_mut()
        .expect("an object")
        .remove("schemaVersion");

    let reply = oneshot(app(root.path()), authorized("POST", "/report", report)).await;

    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

/// Every response carries the version this binary speaks, refusals included.
///
/// A client that gets a `400` needs to know which contract produced it before it can
/// decide what to do, and an error response without a version is the one response
/// where the client has nothing to compare against.
#[tokio::test]
async fn every_response_carries_a_schema_version() {
    let root = TempDir::new("schema-version-everywhere");
    let authorization = Some(bearer(TOKEN));

    let cases: Vec<(&str, axum::http::Request<axum::body::Body>)> = vec![
        ("health", authorized("GET", "/health", json!(null))),
        (
            "accepted trigger",
            authorized("POST", "/trigger", support::valid_trigger(root.path())),
        ),
        ("job read", authorized("GET", "/jobs/job-1", json!(null))),
        (
            "accepted report",
            authorized("POST", "/report", support::valid_report()),
        ),
        (
            "unauthenticated",
            request("GET", "/health", Some(json!(null)), None),
        ),
        (
            "malformed body",
            authorized("POST", "/trigger", json!({ "schemaVersion": "v1" })),
        ),
        (
            "unknown route",
            request(
                "GET",
                "/no-such-route",
                Some(json!(null)),
                authorization.as_deref(),
            ),
        ),
    ];

    for (label, outgoing) in cases {
        let reply = oneshot(app(root.path()), outgoing).await;
        let body = reply.json();

        assert_eq!(
            body["schemaVersion"],
            json!("v1"),
            "{label} (status {}) did not carry a schemaVersion; body was {}",
            reply.status,
            reply.text()
        );
    }
}

// ---------------------------------------------------------------------------
// Unknown-key rejection
// ---------------------------------------------------------------------------

/// Unknown keys are rejected on every route that takes a body.
///
/// ADR 0008 §2.3 records the asymmetry on purpose: "the engine's Zod `z.object`
/// schemas *strip* unknown keys; the router *rejects* them. That asymmetry is what
/// §2.2 wants of Tier 1, but it is a real semantic difference between two components
/// over the same schema and is recorded here so it is not later 'fixed' into
/// symmetry."
///
/// This test is what "not later fixed into symmetry" looks like as executable code. If
/// someone "aligns" the router with the engine by losing `deny_unknown_fields`, this
/// fails.
///
/// `/health` and `/jobs/{id}` are absent because they take no body, and a claim about
/// them would have nothing to assert. `the_bodyless_routes_answer_their_own_answers`
/// covers those two, and `f03_no_route_answers_without_a_bearer` is the test that spans
/// all four routes.
#[tokio::test]
async fn an_unknown_key_is_rejected_on_every_route_that_takes_a_body() {
    let root = TempDir::new("unknown-keys");

    let mut trigger = support::valid_trigger(root.path());
    trigger["__aibr_unknown_key__"] = json!(true);

    let mut report = support::valid_report();
    report["__aibr_unknown_key__"] = json!(true);

    for (method, path, body) in [("POST", "/trigger", trigger), ("POST", "/report", report)] {
        let reply = oneshot(app(root.path()), authorized(method, path, body)).await;

        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{method} {path} accepted an unknown key; body was {}",
            reply.text()
        );
    }
}

/// The two bodyless routes answer their own answers.
///
/// Without this, "every route rejects unknown keys" is trivially satisfiable by a
/// router whose read routes do not exist -- which is very nearly what this router is,
/// and a property worth proving before it is asserted anywhere.
#[tokio::test]
async fn the_bodyless_routes_answer_their_own_answers() {
    let root = TempDir::new("bodyless-routes");

    for (method, path, expected) in [
        ("GET", "/health", StatusCode::OK),
        ("GET", "/jobs/job-1", StatusCode::NOT_FOUND),
    ] {
        let reply = oneshot(app(root.path()), authorized(method, path, json!(null))).await;

        assert_eq!(
            reply.status, expected,
            "{method} {path} answered {}",
            reply.status
        );
    }
}

/// The `schemaVersion` envelope key is the *only* key taken from a body.
///
/// The companion to the envelope design documented in `aibr_router::validate`:
/// removing one required, version-checked key is not the engine's "strip unknown keys"
/// behaviour. If this test fails, the router has started stripping, and ADR 0008
/// §2.3's asymmetry has been resolved in the wrong direction.
///
/// Both keys are here deliberately: one arbitrary, one that looks like a typo of a
/// real field. A strip-everything implementation passes an arbitrary-key check on
/// some schemas and fails a typo-shaped one, so the typo is the case worth having.
#[tokio::test]
async fn the_envelope_key_is_the_only_one_removed_from_a_body() {
    let root = TempDir::new("envelope-only");
    let mut trigger = support::valid_trigger(root.path());
    trigger["prompt_text"] = json!("a typo-shaped unknown");
    trigger["__aibr_unknown_key__"] = json!(1);

    let reply = oneshot(app(root.path()), authorized("POST", "/trigger", trigger)).await;

    assert_eq!(
        reply.status,
        StatusCode::BAD_REQUEST,
        "a body with unknown keys was admitted, so the router is stripping rather \
         than rejecting; body was {}",
        reply.text()
    );
}

// ---------------------------------------------------------------------------
// Body cap
// ---------------------------------------------------------------------------

/// A body of exactly 1 MiB is accepted, and one byte more is not.
///
/// Both sides of the boundary are asserted because they are separate claims: a test
/// that checks only one passes with an off-by-one in either direction.
///
/// The body is built by padding `prompt` so the *serialised* length is exactly
/// 1 048 576. Padding a field the schema already permits keeps the test honest — a
/// body that hit the cap while being structurally invalid would pass the `413`
/// assertion for the wrong reason, and one padded into an unparseable state would
/// pass the `202` assertion for the wrong reason too.
#[tokio::test]
async fn the_body_cap_accepts_exactly_one_mebibyte_and_refuses_one_more() {
    let root = TempDir::new("body-cap");
    const LIMIT: usize = 1_048_576;

    let at_limit = padded_trigger(root.path(), LIMIT);
    assert_eq!(
        at_limit.to_string().len(),
        LIMIT,
        "the fixture must serialise to exactly the limit"
    );
    let reply = oneshot(app(root.path()), authorized("POST", "/trigger", at_limit)).await;
    assert_eq!(
        reply.status,
        StatusCode::ACCEPTED,
        "a body of exactly {LIMIT} bytes was refused; body was {}",
        reply.text()
    );

    let over_limit = padded_trigger(root.path(), LIMIT + 1);
    assert_eq!(over_limit.to_string().len(), LIMIT + 1);
    let reply = oneshot(app(root.path()), authorized("POST", "/trigger", over_limit)).await;
    assert_eq!(
        reply.status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "a body of {} bytes was not refused as too large; body was {}",
        LIMIT + 1,
        reply.text()
    );
}

/// The cap is enforced on the bytes actually read, not on the `Content-Length`.
///
/// A client is under no obligation to report its body size correctly. If the only
/// check were the header, a request declaring `Content-Length: 12` and then
/// streaming a megabyte-plus would pass — which turns the 32 MiB `MemoryMax` (ADR
/// 0008 §2.7) into a one-request denial of service.
///
/// `axum::body` cannot produce a mismatched `Content-Length` from a normal builder,
/// so the fixture is a hand-built request with the two fields set independently.
#[tokio::test]
async fn the_body_cap_does_not_trust_content_length() {
    use axum::body::Body;
    use axum::http::Request;

    let root = TempDir::new("body-cap-lying");
    let oversized = padded_trigger(root.path(), 1_048_577);

    let outgoing = Request::builder()
        .method("POST")
        .uri("/trigger")
        .header("authorization", bearer(TOKEN))
        .header("content-type", "application/json")
        // Deliberately wrong, and the only place a caller-supplied number about body
        // size reaches the router.
        .header("content-length", "12")
        .body(Body::from(oversized.to_string()))
        .expect("a well-formed request");

    let reply = oneshot(app(root.path()), outgoing).await;

    assert_eq!(
        reply.status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "a body of 1 MiB + 1 was buffered because it declared 12 bytes; body was {}",
        reply.text()
    );
}

/// A trigger padded to exactly `length` bytes when serialised.
///
/// The arithmetic is `length - base + original_prompt_length`, not `length - base`: the
/// replacement prompt has to be longer than the one it replaces by the same margin, or
/// the fixture lands `original_prompt_length` bytes short of the target. That mistake
/// produced a body 12 bytes *under* the limit while the test believed it was 1 byte
/// over, which is why the fixture asserts its own serialised length before use — the
/// assertion is the only part that catches this, and both call sites keep it.
///
/// Padding `prompt` is safe for the contract because `prompt` is `z.string().min(1)`
/// with no upper bound in the committed schema, so a megabyte of it is schema-valid. If
/// a future contract adds a length bound, this fixture stops producing a `202` and the
/// failure says exactly that.
fn padded_trigger(project_root: &Path, length: usize) -> Value {
    let mut trigger = support::valid_trigger(project_root);
    let original_prompt = trigger["prompt"].as_str().expect("a string prompt").len();
    let base = trigger.to_string().len();

    assert!(
        length >= base,
        "cannot pad a {base}-byte trigger down to {length} bytes"
    );
    trigger["prompt"] = json!("x".repeat(length - base + original_prompt));
    trigger
}

// ---------------------------------------------------------------------------
// The boundary itself: this crate decides nothing
// ---------------------------------------------------------------------------

/// The load-bearing test of the whole milestone.
///
/// A structurally perfect trigger, from a source that appears nowhere in
/// `config.security.allowed_sources`, for a capability that source has never been
/// granted, is **admitted**.
///
/// That is not a bug and not an oversight. It is ADR 0008 §2.2's two tiers working:
/// the router filters shape, the worker decides permission. The engine's
/// `trigger.ts` calls `assertSourceAuthorized`; the router must not. A component with
/// no identity model that also held the source allowlist would be a second, weaker
/// copy of authority the worker already has, and would relocate a High finding rather
/// than close one.
///
/// This test exists so that "fixing" it fails. The obvious future improvement —
/// reading `allowed_sources` in the router, because the config is right there and the
/// check is three lines — is exactly the change that manufactures a new High finding,
/// and without this test it would read as a hardening win in review.
#[tokio::test]
async fn a_structurally_valid_trigger_from_an_unauthorized_source_is_still_admitted() {
    let root = TempDir::new("tier-boundary");

    // Sanity: the fixture really is from a source the config does not list. If this
    // stops being true, the test would pass for the wrong reason.
    let configured = config_json(root.path())["security"]["allowed_sources"]
        .as_array()
        .expect("an array")
        .clone();
    assert!(
        !configured.iter().any(|source| {
            source["source_agent_id"] == json!("some-source-that-is-not-configured")
        }),
        "the fixture source must not be in the configured allowlist, or this test \
         asserts nothing"
    );

    let reply = oneshot(
        app(root.path()),
        authorized("POST", "/trigger", support::valid_trigger(root.path())),
    )
    .await;

    assert_eq!(
        reply.status,
        StatusCode::ACCEPTED,
        "an unauthorized source was refused by the router; body was {}\n\n\
         This is the authority creep ADR 0008 section 2.2 forbids. The router is a \
         rejection filter, not an authorization component. assertSourceAuthorized \
         belongs to the worker (Tier 2), which re-runs triggerRequestSchema on the \
         delivered payload and evaluates the source allowlist itself.\n\n\
         If you are here because you wanted the router to reject unauthorized \
         sources: that is the wrong component, and adding the check here manufactures \
         a High finding rather than closing one.",
        reply.text()
    );
}

/// And a `plan_status: "approved"` in `metadata` buys nothing at the router.
///
/// `F-05` (closed by M4-A in the engine) was a route returning a named
/// `legacy.runtime.launch` outbox record carrying its own checks as an
/// `authorization` block — "integrity standing for authenticity". ADR 0008 §2.2 then
/// says of the router explicitly: "`plan_status: \"approved\"` is not a trust signal
/// to the router."
///
/// The router must admit this exactly as it admits the unauthorized-source case,
/// because from the router's position the two requests differ only in a field it does
/// not read.
#[tokio::test]
async fn plan_status_approved_is_not_a_trust_signal_to_the_router() {
    let root = TempDir::new("plan-status");

    let mut trigger = support::valid_trigger(root.path());
    trigger["metadata"] = json!({
        "plan_status": "approved",
        "plan_reference": "plan-1"
    });

    let reply = oneshot(app(root.path()), authorized("POST", "/trigger", trigger)).await;

    assert_eq!(
        reply.status,
        StatusCode::ACCEPTED,
        "the router refused a trigger because plan_status was not approved, or \
         refused it for another reason; body was {}\n\n\
         The router does not implement plan approval. plan_status is an ASSERTION from \
         the caller (F-05), evaluated by ConfigPlanReviewProvider in the worker. A \
         router that reads it relocates F-05 into a component with no identity model.",
        reply.text()
    );
}

/// `POST /report` admits an unauthorized source too, for the same reason `/trigger`
/// does. Tier 2 owns the source allowlist on both routes.
///
/// The engine's `report.ts` checks `allowed_sources` at line 16. That check belongs
/// to the worker.
#[tokio::test]
async fn a_report_from_an_unauthorized_source_is_still_admitted() {
    let root = TempDir::new("report-tier-boundary");

    let reply = oneshot(
        app(root.path()),
        authorized("POST", "/report", support::valid_report()),
    )
    .await;

    assert_eq!(
        reply.status,
        StatusCode::ACCEPTED,
        "body was {}",
        reply.text()
    );
}

// ---------------------------------------------------------------------------
// The two routes that must not exist
// ---------------------------------------------------------------------------

/// ADR 0008 §6: `GET /v1/mesh/terminal` stays on the Bun process, and "a test must
/// assert the router answers `404` for both paths and never `101` or a streaming
/// `200`, so a future migration cannot assume they moved."
///
/// The upgrade request is the load-bearing part. A router that had the `ws` feature
/// and simply not registered the path would still answer `404` to a plain `GET`, so a
/// bare-status assertion would pass while the route table was one entry away from a
/// `101`.
#[tokio::test]
async fn the_websocket_terminal_route_does_not_exist_in_the_router() {
    let root = TempDir::new("mesh-terminal");

    let reply = support::upgrade(app(root.path()), "/v1/mesh/terminal").await;

    assert_eq!(
        reply.status,
        StatusCode::NOT_FOUND,
        "GET /v1/mesh/terminal answered {}.\n\
         A queue cannot be interposed between a peer and a stateful connection: the \
         ownership token, the attach guard and the takeover protocol (SF-10) are \
         per-connection state with no durable analogue in this milestone. This route \
         stays on the Bun process (ADR 0008 section 6).",
        reply.status
    );
    assert_ne!(reply.status, StatusCode::SWITCHING_PROTOCOLS);
    assert!(
        !reply.headers.contains_key("upgrade"),
        "an Upgrade response on a stateful mesh route is a finding, not a feature; \
         headers were {:?}",
        reply.headers
    );
}

/// ADR 0008 §6 for the SSE stream, and the "never a streaming `200`" half.
///
/// `/v1/mesh/events` is a long-lived SSE stream with snapshot re-base and cursor
/// resume. A `200` here would be worse than a `404` in one specific way: an SSE
/// client connects, receives headers saying a stream is starting, and then waits for
/// events this component will never produce — so the failure presents as a peer that
/// is silently healthy. The assertion is therefore on the status *and* on the absence
/// of the content type that makes a `200` a stream.
#[tokio::test]
async fn the_sse_events_route_does_not_exist_in_the_router() {
    let root = TempDir::new("mesh-events");

    let reply = support::upgrade(app(root.path()), "/v1/mesh/events").await;

    assert_eq!(
        reply.status,
        StatusCode::NOT_FOUND,
        "GET /v1/mesh/events answered {}.\n\
         The SSE cursor and snapshot re-base are per-connection state (ADR 0008 \
         section 6). This route stays on the Bun process.",
        reply.status
    );
    assert_ne!(reply.status, StatusCode::SWITCHING_PROTOCOLS);
    assert_ne!(
        reply
            .headers
            .get("content-type")
            .map(|value| value.as_bytes()),
        Some(b"text/event-stream".as_slice()),
        "the router must never produce an SSE content type; headers were {:?}",
        reply.headers
    );
}

/// Neither mesh path is reachable by any method.
///
/// A `404` fallback registered for `GET` alone would leave `POST /v1/mesh/events` to
/// axum's default, which answers `405` — a status that says "the resource exists,
/// wrong method", which is the same disclosure in a smaller package.
#[tokio::test]
async fn neither_mesh_path_is_reachable_by_any_method() {
    let root = TempDir::new("mesh-methods");

    for path in ["/v1/mesh/terminal", "/v1/mesh/events"] {
        for method in ["GET", "POST", "PUT", "DELETE", "PATCH"] {
            let reply = oneshot(
                app(root.path()),
                request(method, path, Some(json!(null)), Some(&bearer(TOKEN))),
            )
            .await;

            assert_eq!(
                reply.status,
                StatusCode::NOT_FOUND,
                "{method} {path} answered {}; both mesh paths must be 404 for every \
                 method, not 405",
                reply.status
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/// `/health` reports the router's own liveness and nothing else.
///
/// It does **not** call opencode. The engine's route returns
/// `{"ok": true, "opencode": await health()}`
/// ([`src/server/routes/health.ts:5`](../../src/server/routes/health.ts)), which
/// makes a liveness probe depend on a second process — and from M7.7 the engine sits
/// *behind* this router. A probe that reports "the bridge is down" when only
/// `opencode serve` is down tells a supervisor to restart the wrong process.
///
/// The absence of an `opencode` key is asserted, not merely the absence of a call, so
/// the field cannot be reintroduced later as a cached value.
#[tokio::test]
async fn health_reports_only_the_router() {
    let root = TempDir::new("health");

    let reply = oneshot(app(root.path()), authorized("GET", "/health", json!(null))).await;

    assert_eq!(reply.status, StatusCode::OK);
    let body = reply.json();
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["schemaVersion"], json!("v1"));
    assert!(
        body.get("opencode").is_none(),
        "the router must not report opencode health; it does not own that process and \
         M7.7 makes the worker the component that can answer it. Body was {}",
        reply.text()
    );
}

/// `GET /jobs/:id` answers `404` for a well-formed id too.
///
/// The route has no store, so `404` is truthful rather than a stub: this process does
/// not know whether the job exists. Asserting it for a *valid* id as well as an
/// invalid one is what distinguishes "the gate refuses bad ids" from "the gate refuses
/// everything".
#[tokio::test]
async fn the_job_read_route_answers_not_found_for_every_id() {
    let root = TempDir::new("jobs-always-404");

    for id in ["job-1", "a", &"z".repeat(128)] {
        let reply = oneshot(
            app(root.path()),
            authorized("GET", &format!("/jobs/{id}"), json!(null)),
        )
        .await;

        assert_eq!(
            reply.status,
            StatusCode::NOT_FOUND,
            "GET /jobs/{id} answered {}; the router has no job store and must answer \
             404 for every id (M7.7 wires this route to the worker). Body was {}",
            reply.status,
            reply.text()
        );
        assert_eq!(reply.json()["error"], json!("not found"));
    }
}

/// The `202` shapes for trigger and report.
///
/// `target_agent_id` IS echoed, from the configured `agent_id`. An earlier draft
/// of this file asserted its absence, on the reasoning that echoing it "would be
/// asserting that this process *is* that target". Two things are wrong with that.
///
/// First, the contract: `target_agent_id` is REQUIRED by
/// [`contracts/v1/trigger-response.schema.json`](../../contracts/v1/trigger-response.schema.json)
/// (from `triggerResponseSchema`, [`src/config/schemas.ts:89`](../../src/config/schemas.ts)).
/// A response omitting a required field does not validate against the schema this
/// binary generates from. Nothing else in the suite would have caught it: the
/// parity test in `fixtures.rs` checks the fifteen example fixtures against their
/// INPUT schemas, and no fixture is a response body.
///
/// Second, the reasoning confused echoing with deciding. The router reads
/// `agent_id` from ITS OWN config, never from the request. The engine's
/// `trigger.ts` reads the same field for the same reason. Deciding that the
/// router stands in front of a particular agent — which is what "this process is
/// that target" would mean — remains the worker's call, and the router still
/// admits a structurally valid trigger from an unconfigured source (see
/// `a_structurally_valid_trigger_from_an_unauthorized_source_is_still_admitted`).
///
/// `status` and `opencode_session_id` remain absent, and the original reasons hold:
/// both describe a job lifecycle and a runtime this
/// process does not have. The M7.7 cutover reconciles all three with the committed
/// schema and it is recorded in `Docs/implementation-reports/m7.3-progress.md`.
#[tokio::test]
async fn the_accepted_shapes_are_stable() {
    let root = TempDir::new("accepted-shapes");

    let reply = oneshot(
        app(root.path()),
        authorized("POST", "/trigger", support::valid_trigger(root.path())),
    )
    .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED);
    let trigger = reply.json();
    assert_eq!(trigger["accepted"], json!(true));
    assert!(trigger["job_id"].is_string());
    assert!(trigger["status_url"].is_string());
    assert_eq!(trigger["schemaVersion"], json!("v1"));
    assert!(
        trigger.get("opencode_session_id").is_none(),
        "the router does not create an opencode session; the worker does. Body was {}",
        reply.text()
    );
    assert!(
        trigger.get("status").is_none(),
        "`status: accepted|blocked|failed` describes a job lifecycle this process does \
         not have. Emitting `accepted` would claim a state it cannot observe. Body was \
         {}",
        reply.text()
    );
    // `target_agent_id` IS required by the committed triggerResponseSchema, so it
    // is echoed from config. This reverses an earlier assertion in this file that
    // demanded its ABSENCE, on the reasoning that the router "does not claim to be
    // the target agent". That reasoning was wrong about the contract: a required
    // field cannot be omitted, and a response that fails its own generated schema
    // is a violation the parity test cannot catch, since no
    // tests/contracts/examples/ fixture covers a RESPONSE body.
    //
    // Echoing the configured `agent_id` is not a claim of authority. The engine's
    // `trigger.ts` reads the same field for the same purpose, and the router still
    // cannot tell whether the caller may dispatch -- see
    // `a_structurally_valid_trigger_from_an_unauthorized_source_is_still_admitted`.
    assert_eq!(
        trigger["target_agent_id"],
        json!(support::CONFIGURED_AGENT_ID),
        "target_agent_id is REQUIRED by contracts/v1/trigger-response.schema.json and \
         must be the configured agent_id. Body was {}",
        reply.text()
    );

    let reply = oneshot(
        app(root.path()),
        authorized("POST", "/report", support::valid_report()),
    )
    .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED);
    let report = reply.json();
    assert_eq!(report["accepted"], json!(true));
    assert_eq!(report["schemaVersion"], json!("v1"));
}

// ---------------------------------------------------------------------------
// The bearer never appears in a response
// ---------------------------------------------------------------------------

/// ADR 0008 §9: "A canary bearer token appears in no log, diagnostic, or error body,
/// following the audit pattern in `tests/unit/notifications/no-secrets.test.ts`."
///
/// Every failure path a caller can reach is walked, because the token could leak from
/// any of them and the rare ones are where it would. A `401` that echoed the presented
/// token would be the worst of these: it is the one response whose entire job is to be
/// read by a client that has just sent the secret.
#[tokio::test]
async fn the_bearer_never_appears_in_a_response_body() {
    let root = TempDir::new("no-secrets");

    let cases: Vec<(&str, &str, &str, Value)> = vec![
        (
            "wrong token",
            "POST",
            "/trigger",
            support::valid_trigger(root.path()),
        ),
        (
            "no token at all",
            "POST",
            "/trigger",
            support::valid_trigger(root.path()),
        ),
        (
            "malformed body",
            "POST",
            "/trigger",
            json!({ "nonsense": true }),
        ),
        (
            "oversize body",
            "POST",
            "/trigger",
            json!({ "pad": "x".repeat(1_048_600) }),
        ),
        ("unknown route", "GET", "/does-not-exist", json!(null)),
    ];

    for (label, method, path, body) in cases {
        let presentation = match label {
            "wrong token" => "Bearer not-the-token".to_owned(),
            "no token at all" => String::new(),
            _ => bearer(TOKEN),
        };

        let reply = oneshot(
            app(root.path()),
            request(method, path, Some(body), Some(&presentation)),
        )
        .await;
        let text = reply.text();

        for secret in [TOKEN, "not-the-token", &TOKEN[7..]] {
            assert!(
                !text.contains(secret),
                "{label}: a bearer token appeared in a {status} body: {text}",
                status = reply.status
            );
        }
    }
}

/// No error body echoes any part of the request back.
///
/// The narrower, stronger version of the audit above: the router's `400`s are built
/// from a closed set of static strings precisely so that this holds. A `details` array
/// naming an offending key or a path would put caller-controlled bytes into a response
/// and make this test fail, which is the point of asserting it separately from the
/// token audit.
#[tokio::test]
async fn no_refusal_body_quotes_the_request() {
    let root = TempDir::new("no-echo");
    let canary = "a-string-that-appears-only-in-the-request";

    let mut trigger = support::valid_trigger(root.path());
    trigger["prompt"] = json!(canary);
    trigger["schemaVersion"] = json!("v99");

    let reply = oneshot(app(root.path()), authorized("POST", "/trigger", trigger)).await;

    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert!(
        !reply.text().contains(canary),
        "a refusal quoted the request body: {}",
        reply.text()
    );
}

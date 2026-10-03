//! Shared fixtures and request helpers for the router's integration tests.
//!
//! Not a test target itself: it lives in `tests/support/` rather than
//! `tests/support.rs` because Cargo compiles every `tests/*.rs` as its own test
//! binary, and a helpers module compiled as a test binary is a test target with
//! zero tests in it.
//!
//! # Requests are driven through `Router::oneshot`, never a socket
//!
//! Almost every test here constructs a `Router` and calls it with
//! [`tower::util::ServiceExt::oneshot`]. No `TcpListener` is created, no port is
//! bound, and no test can pass because a listener happened to be up. The one
//! exception is [`spawn_router`], which deliberately runs the real binary to test
//! the exit-78 preflight — the only behaviour in this milestone that cannot be
//! observed from inside the library, because it is an exit code.
//!
//! A `Router` cannot be reused across requests because `oneshot` consumes it, so
//! [`app`] builds a fresh one per call and the tests never hold a clone. Building it
//! per request also means no test can be affected by state another test left in a
//! shared router.

// Each of the three test binaries compiles this module in full and uses a different
// subset of it, so every helper is dead code in two of the three. The alternative is
// three copies of these fixtures, which is worse than a lint suppression: the copies
// would drift, and a drift between two fixture sets is exactly the silent divergence
// `router/tests/fixtures.rs` refuses to accept between the two contract languages.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use aibr_router::auth::Bearer;
use aibr_router::routes::AppState;
use axum::body::Body;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::util::ServiceExt;

/// The bearer token every test presents unless it is testing the bearer.
///
/// Chosen to be a canary. `the_bearer_never_appears_in_a_response_body` greps every
/// response this suite produces for this exact string, so a leak on any failure path
/// is a test failure rather than something a reviewer has to notice. This follows
/// `tests/unit/notifications/no-secrets.test.ts`, which is the audit ADR 0008 §9
/// points at for the "no token in a log, diagnostic, or error body" rule.
pub const TOKEN: &str = "auth_bearer_does_not_appear_in_any_response_body";

/// A response, with everything the tests want to look at.
pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    /// The body parsed as JSON.
    ///
    /// Panics with the status and the raw bytes if it is not JSON, because "the
    /// router answered with something that is not JSON" is a failure of the thing
    /// under test and a silent `None` would hide it.
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|error| {
            panic!(
                "expected a JSON body at {}, got {} bytes: {error}\nbody: {}",
                self.status,
                self.body.len(),
                String::from_utf8_lossy(&self.body)
            );
        })
    }

    /// The body as text, for "the token is not in here" assertions.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// A `BridgeConfig` whose `projects[].path` is `project_root`.
///
/// Written out in full rather than deserialised from `config/dev-main.example.json`
/// because the containment tests need the project root to be a directory they
/// control. Parsing the *real* example config is a separate test — see
/// `the_committed_example_config_parses` — because that is a different claim: that
/// the router can read the file the engine reads, not that any particular project
/// path works.
/// The `agent_id` [`config_json`] writes.
///
/// Named so a test asserting the router's `202` echoes it does not hard-code the
/// literal a second time: the literal lives here, where the fixture that defines
/// it is, so changing one changes both.
pub const CONFIGURED_AGENT_ID: &str = "router-test";

pub fn config_json(project_root: &Path) -> Value {
    json!({
        "agent_id": CONFIGURED_AGENT_ID,
        "bridge": {
            // `127.0.0.1`, not a tailnet address: these tests exercise the gate, not
            // the bind. A real tailnet address would make every test need a tailnet.
            // `bind::preflight` is tested separately, both as a function and
            // against a spawn of the real binary.
            "host": "127.0.0.1",
            "port": 8787,
            "public_url": "http://router-test.tailnet:8787"
        },
        "opencode": {
            "base_url": "http://127.0.0.1:4096",
            "server_port": 4096,
            "username": "opencode",
            "password_env": "OPENCODE_SERVER_PASSWORD"
        },
        "security": {
            "auth_mode": "bearer-token",
            // Exactly one source, and it is NOT the one the requests under test
            // claim to be from. That is what makes
            // `a_structurally_valid_trigger_from_an_unauthorized_source_is_still_admitted`
            // mean something: if the router ever started reading this list, the
            // trigger that test admits would start being refused.
            "allowed_sources": [
                {
                    "source_agent_id": "the-only-authorized-source",
                    "capabilities": ["testing"],
                    "requires_plan_approval": []
                }
            ]
        },
        "permissions": {
            "default_response": "reject",
            "allow_tools": ["read"],
            "require_plan_approval_for_tools": ["bash", "write"]
        },
        "projects": [
            {
                "id": "test-project",
                "path": project_root.to_string_lossy(),
                "capabilities": ["development"]
            }
        ],
        "agents": [
            {
                "id": "peer",
                "url": "http://peer.tailnet:8787",
                "capabilities": ["testing"]
            }
        ],
        "timeouts": {
            "default_job_seconds": 1800,
            "callback_retry_attempts": 3
        },
        "planning": {
            "plan_annotator_enabled": true,
            "require_approval_for": ["deployment"]
        }
    })
}

/// Handler state for `project_root`, with the canary bearer.
pub fn state(project_root: &Path) -> AppState {
    AppState {
        auth: std::sync::Arc::new(Bearer::new(TOKEN).expect("the canary token is not empty")),
        project_roots: std::sync::Arc::new(vec![canonical(project_root)]),
        public_url: std::sync::Arc::from("http://router-test.tailnet:8787"),
        // Matches `config_json`'s `agent_id`, which is what
        // `AppState::from_config` would read. Asserted by
        // `the_accepted_shapes_are_stable`, so a divergence between the fixture
        // config and this state is a test failure rather than a silent mismatch.
        agent_id: std::sync::Arc::from(CONFIGURED_AGENT_ID),
    }
}

/// A fresh router. `oneshot` consumes the `Router`, so each request gets its own.
pub fn app(project_root: &Path) -> Router {
    aibr_router::routes::build(state(project_root))
}

/// `realpath`, because `/tmp` is a symlink on macOS.
///
/// The containment tests compare canonicalised paths against canonicalised
/// configured roots. If the fixture handed the router a non-canonical root while the
/// test compared it against a canonical candidate, every assertion would fail on a
/// path prefix rather than on the behaviour under test — a test that passes on Linux
/// and fails on the reference host for reasons that have nothing to do with the code.
pub fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path)
        .unwrap_or_else(|error| panic!("cannot canonicalize {}: {error}", path.display()))
}

/// Assemble a request.
///
/// `authorization` is the *whole* header value, so a test can present `bearer x`,
/// `Bearer` with no space, or an empty string without the helper second-guessing it.
pub fn request(
    method: &str,
    uri: &str,
    body: Option<Value>,
    authorization: Option<&str>,
) -> Request<Body> {
    let method = axum::http::Method::from_bytes(method.as_bytes())
        .unwrap_or_else(|error| panic!("{method:?} is not a known HTTP method: {error}"));
    let mut builder = Request::builder().method(method).uri(uri);

    if let Some(value) = authorization {
        builder = builder.header(header::AUTHORIZATION, value);
    }

    let body = match body {
        Some(value) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&value).expect("the fixture serialises"))
        }
        None => Body::empty(),
    };

    builder.body(body).expect("a well-formed request")
}

/// A request carrying a valid bearer.
pub fn authorized(method: &str, uri: &str, body: Value) -> Request<Body> {
    request(method, uri, Some(body), Some(&bearer(TOKEN)))
}

/// A request carrying no bearer at all.
pub fn unauthenticated(method: &str, uri: &str, body: Value) -> Request<Body> {
    request(method, uri, Some(body), None)
}

/// `Bearer <token>`, assembled here so the prefix appears once.
pub fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// Send one request and return the whole reply.
pub async fn oneshot(app: Router, request: Request<Body>) -> Reply {
    let response = app
        .oneshot(request)
        .await
        .expect("the router is infallible");
    let status = response.status();
    let headers = response.headers().clone();
    // `usize::MAX`: this reads back whatever the router just built, which is bounded
    // by the router's own body cap. Capping here as well would only make a failure
    // of the *cap* look like a failure of this helper.
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("a body this size always buffers");
    Reply {
        status,
        headers,
        body: body.to_vec(),
    }
}

/// Send a `GET` carrying a WebSocket upgrade, and return the whole reply.
///
/// Used against the two `/v1/mesh/*` paths. The `Upgrade` header is what makes the
/// assertion meaningful: a router that merely had not registered the path would also
/// answer `404` to a plain `GET`, so the bare-status check would pass while the
/// route table was one entry away from a `101`.
pub async fn upgrade(app: Router, uri: &str) -> Reply {
    let request = Request::builder()
        .method("GET")
        .uri(uri)
        .header(header::AUTHORIZATION, bearer(TOKEN))
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(Body::empty())
        .expect("a well-formed upgrade request");
    oneshot(app, request).await
}

/// A `TriggerRequest` that satisfies every structural gate.
///
/// `source_agent_id` is deliberately `some-source-that-is-not-configured`, so this
/// fixture is a trigger the worker would refuse. See
/// `a_structurally_valid_trigger_from_an_unauthorized_source_is_still_admitted`.
pub fn valid_trigger(project_root: &Path) -> Value {
    json!({
        "schemaVersion": "v1",
        "source_agent_id": "some-source-that-is-not-configured",
        "target_agent_id": "router-test",
        "capability": "testing",
        "project_dir": project_root.to_string_lossy(),
        "prompt": "do the thing",
        "callback_url": "http://peer.tailnet:8787/report",
        "timeout_seconds": 600
    })
}

/// A `ReportCallback` that satisfies every structural gate.
pub fn valid_report() -> Value {
    json!({
        "schemaVersion": "v1",
        "job_id": "job-1",
        "source_agent_id": "some-source-that-is-not-configured",
        "target_agent_id": "router-test",
        "status": "completed",
        "summary": "it finished",
        "findings": [],
        "artifacts": [],
        "started_at": "2026-10-03T00:00:00Z",
        "completed_at": "2026-10-03T00:01:00Z"
    })
}

/// A directory that deletes itself.
///
/// `Drop` rather than an explicit cleanup call, so a `panic!` in the middle of a test
/// does not leave a symlink pointing out of a temporary directory in the developer's
/// `/tmp`. Written here rather than pulled in as `tempfile` so the dependency set
/// stays at the four the crate needs; this is about thirty lines and the failure it
/// guards — accumulating symlinks in `/tmp` on a machine that runs this suite often
/// — is real.
///
/// The name is process id plus a counter, which is unique across concurrent
/// `cargo test` binaries without needing a lock. The thread id is deliberately not
/// included: Rust's test harness runs a fixed pool, so two tests on the same thread
/// cannot overlap, and including it would only add a number nobody reads.
pub struct TempDir {
    path: PathBuf,
}

static COUNTER: AtomicU32 = AtomicU32::new(0);

impl TempDir {
    /// Create a fresh, empty directory.
    pub fn new(label: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "aibr-router-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path)
            .unwrap_or_else(|error| panic!("cannot create {}: {error}", path.display()));
        Self {
            path: std::fs::canonicalize(&path).expect("canonicalize the fresh directory"),
        }
    }

    /// This directory, canonicalised.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A directory at `path`, created and canonicalised.
    ///
    /// Absolute paths outside this `TempDir` are allowed and used by the `F-04`
    /// fixtures, which need a project root and a sibling directory under one
    /// scratch root. Cleanup is safe either way because `remove_dir_all` unlinks
    /// symlinks rather than following them.
    pub fn dir(&self, path: impl AsRef<Path>) -> PathBuf {
        let path = path.as_ref();
        std::fs::create_dir_all(path)
            .unwrap_or_else(|error| panic!("cannot create {}: {error}", path.display()));
        std::fs::canonicalize(path).expect("canonicalize the new directory")
    }

    /// A path inside this directory for a config file. Nothing is created.
    ///
    /// Separate from [`TempDir::dir`] because that one makes a *directory*, and
    /// writing JSON over a directory fails with `EISDIR` — an error that names neither
    /// the fixture nor the mistake. A file-path helper that creates nothing keeps the
    /// two apart at the call site.
    pub fn config_path(&self) -> PathBuf {
        self.path.join("config.json")
    }

    /// A symlink at `link` (relative to this directory) pointing at `target`.
    ///
    /// `std::os::unix::fs::symlink`, with no Windows arm: the router targets Linux
    /// and Darwin only (M7.9's matrix), and a Windows symlink would need privileges
    /// the test runner does not have, which is a second reason not to pretend.
    pub fn symlink(&self, link: &str, target: &Path) -> PathBuf {
        let link_path = self.path.join(link);
        std::os::unix::fs::symlink(target, &link_path).unwrap_or_else(|error| {
            panic!(
                "cannot symlink {} -> {}: {error}",
                link_path.display(),
                target.display()
            );
        });
        link_path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // `remove_dir_all` does not follow symlinks out of the tree — it unlinks
        // them — so a test whose whole point is a symlink to somewhere else cannot
        // delete that somewhere else. `TempDir::symlink` deliberately permits targets
        // outside the temp directory; that safety property is what lets the `F-04`
        // test exist without a second scratch tree.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Run the real `aibr-router` binary to completion and return `(exit code, stderr)`.
///
/// Used only by the exit-78 preflight test. A process is the only place an exit code
/// exists, so no amount of library-level testing can cover that half of ADR 0008 §8
/// layer 1.
pub fn spawn_router(config_path: &Path, token: &str) -> (Option<i32>, String) {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_aibr-router"))
        .env("AIBRIDGE_CONFIG", config_path)
        .env("AIBRIDGE_BEARER_TOKEN", token)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .unwrap_or_else(|error| panic!("cannot run aibr-router: {error}"));

    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// Write `value` as pretty JSON to `path`.
pub fn write_config(path: &Path, value: &Value) -> PathBuf {
    let text = serde_json::to_string_pretty(value).expect("the fixture serialises");
    std::fs::write(path, text)
        .unwrap_or_else(|error| panic!("cannot write {}: {error}", path.display()));
    path.to_path_buf()
}

/// Write `text` verbatim to a config file inside `scratch`.
///
/// For the one test that needs a config that is not valid JSON, which no `Value` can
/// express.
pub fn write_raw_config(scratch: &TempDir, text: &str) -> PathBuf {
    let path = scratch.config_path();
    std::fs::write(&path, text)
        .unwrap_or_else(|error| panic!("cannot write {}: {error}", path.display()));
    path
}

//! The four stateless routes, and the two paths that must never be routes.
//!
//! | Method | Path | This router answers |
//! | --- | --- | --- |
//! | `GET` | `/health` | `200 {ok, schemaVersion, queue}` |
//! | `POST` | `/trigger` | `202 {accepted, job_id, target_agent_id, status_url, schemaVersion}` |
//! | `GET` | `/jobs/{id}` | `404 {error, schemaVersion}` — always |
//! | `POST` | `/report` | `202 {accepted, schemaVersion}` |
//!
//! # What a `202` means, since M7.5: the row is committed
//!
//! [`crate::outbox`] returns from `admit` only after `COMMIT` has returned, and the
//! two admitting handlers build their `202` bodies from values that only exist
//! after that call. A store failure is [`ApiError::StoreUnavailable`], a `503`.
//!
//! The ordering is the whole of `SF-08` and it is worth stating what it costs: the
//! caller waits for an `fsync` (`synchronous = FULL`) before it learns whether its
//! request was accepted, and a `503` is a correct answer rather than a degraded one.
//! The alternative ordering — build the response, admit, then send — would hand a
//! caller a `202` for a row that may never exist.
//!
//! # Every route is behind the bearer, including reads
//!
//! That is the whole of finding `F-03`. `createApp()` registers `/jobs/:id` with no
//! authentication at all ([`src/server/app.ts:38`](../../src/server/app.ts)), and
//! the record it returns carries prompt text, an absolute project path, the source
//! agent id and callback metadata. Moving the route here and authenticating it is
//! the closure; leaving reads unauthenticated "because reads are harmless" is the
//! reasoning that produced the finding.
//!
//! # What a `202` does and does not mean
//!
//! **It means: this body is shaped correctly, it carries a version this binary
//! speaks, its bearer matched, and the work is committed to
//! [`crate::outbox`].** Nothing else.
//!
//! **It does not mean the caller is authorized**, and there are three things this
//! crate deliberately does not check that the worker does. Every one of them would
//! be authority, and authority here would be a new High finding manufactured by
//! M7.3:
//!
//! 1. `source_agent_id` against `config.security.allowed_sources`
//!    ([`assertSourceAuthorized`](../../src/security/source-authorization.ts)).
//!    The router never reads `allowed_sources`. It could — the config is loaded and
//!    parsed — and the test
//!    `a_structurally_valid_trigger_from_an_unauthorized_source_is_still_admitted`
//!    exists to keep that true.
//! 2. Whether `project_dir` is an allowlisted *project*, as opposed to being inside
//!    a configured root. See [`crate::validate::canonical_project_dir`].
//! 3. `plan_status: "approved"` in `metadata`. `F-05` disposes of legacy approval
//!    fields as *assertions*. A component with no identity model that reads one as
//!    a credential relocates that finding into a component with fewer defences than
//!    the one it replaces (ADR 0008 §2.2).
//!
//! The engine's `trigger.ts` ordering — source, then project, then plan, then
//! opencode health, then dependencies — is unchanged in M7.7 and runs in the
//! worker, after the payload leaves this process.
//!
//! # Why `GET /jobs/{id}` answers `404` to everything
//!
//! Because the router does not read the job store. It has no store: `JsonFileJobStore`
//! is the engine's, and M7.5 puts durable admission in `ingress_outbox` while the
//! engine's job records stay where they are. Inventing a read path here would mean
//! the router either duplicates the engine's store or starts answering questions
//! about job state it does not own — the second of which is exactly the authority
//! this crate must not have.
//!
//! A `404` here is therefore **truthful, not a stub**: this process genuinely does
//! not know whether the job exists. What it is not is *durable* — M7.7 wires this
//! route to the worker's view. The id is still charset-checked
//! ([`crate::validate::valid_job_id`]), because `F-01` is about a traversal
//! reaching a filesystem and that risk does not care whether there is a store
//! behind it yet; the store arrives later and the gate is already in front of it.
//!
//! # Why `/v1/mesh/*` is not here
//!
//! ADR 0008 §6: `GET /v1/mesh/terminal` is a WebSocket with single-input-owner
//! semantics (`SF-10`), and `GET /v1/mesh/events` is an SSE stream with cursor
//! resume. **A queue cannot be interposed between a peer and a stateful
//! connection** — the ownership token, the attach guard and the resume cursor are
//! per-connection state with no durable analogue in this milestone. They stay on
//! the Bun process.
//!
//! The guarantee is structural, not a matter of remembering to leave a route out:
//! axum's `ws` feature is **not enabled** ([`Cargo.toml`](../../Cargo.toml)), so
//! `WebSocketUpgrade` does not exist in this build and a `101` is not
//! constructible. The router's `fallback` is the other half — a JSON `404` rather
//! than axum's empty one — so an unmatched path cannot accidentally look like a
//! streaming response either.

use std::ops::Deref;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::auth::Bearer;
use crate::config::RouterConfig;
use crate::contracts::{ReportCallback, TriggerRequest};
use crate::error::ApiError;
use crate::outbox::{Admission, IngressOutbox};
use crate::validate::{self, MAX_BODY_BYTES};
use crate::CONTRACT_VERSION;

/// State every handler shares. Cheap to clone so a request never borrows it.
///
/// `project_roots` and `public_url` are wrapped in `Arc` because they are
/// `Vec<PathBuf>` and `String` — small, but cloned per handler invocation, and this
/// is the ingress hot path of a component whose RSS is gated at 4 MiB.
#[derive(Clone)]
pub struct AppState {
    pub auth: Arc<Bearer>,
    pub project_roots: Arc<Vec<PathBuf>>,
    /// `bridge.public_url` from `config.json`, used to build `status_url`.
    ///
    /// Operator configuration, not a caller-supplied destination, so composing it
    /// into a response is not an open-redirect surface: nothing a caller sends
    /// reaches it. (The genuinely open-redirect-shaped field in these payloads is
    /// `callback_url`, and `F-02`/§2.6 binds it at enqueue in M7.8, not here.)
    pub public_url: Arc<str>,
    /// `agent_id` from `config.json`.
    ///
    /// Carried for ONE reason: the committed `triggerResponseSchema` lists
    /// `target_agent_id` as REQUIRED, and the M7.3 draft returned a `202` that
    /// omitted it. A response that does not validate against the contract the
    /// binary generates from is a contract violation the parity test cannot see,
    /// because the parity test checks the fifteen `tests/contracts/examples/`
    /// fixtures against their INPUT schemas — no fixture covers a response body.
    ///
    /// This is operator configuration echoed back, not an authorization decision:
    /// the engine's own route does the same (`trigger.ts` reads
    /// `dependencies.config.agent_id` for exactly this field), and the router
    /// still cannot tell whether the caller may dispatch.
    pub agent_id: Arc<str>,
    /// The durable admission queue.
    ///
    /// **Not optional and not defaulted.** There is no `Option<IngressOutbox>` and
    /// no in-memory constructor reachable from here, because either would be a
    /// `202` from a process that has not committed anything — see
    /// [`crate::outbox`]'s module docs for the failure that produces. The store
    /// arrives already-open from `main`, which opens it with
    /// [`IngressOutbox::open`] and exits `78` if it cannot.
    ///
    /// Behind an `Arc` for the same reason as the rest of this struct: every request
    /// clones the state, and a `Connection` is not `Clone`. The `Arc` is not
    /// optional either — `IngressOutbox` is itself a `Mutex<Connection>`, and
    /// handing the connection to two threads directly would move the concurrency
    /// control out of the type that documents it.
    pub outbox: Arc<IngressOutbox>,
}

impl AppState {
    /// Derive handler state from loaded configuration and an **already open** store.
    ///
    /// Takes the store as an argument rather than opening one, and that is the
    /// boundary of M7.5: opening happens in `main`, once, before any socket exists,
    /// so a store that cannot be opened is an exit `78` rather than a `503` that
    /// arrives one request at a time. Which of the two an operator sees is the
    /// difference between "fix the config" and "the router is degraded".
    pub fn from_config(config: &RouterConfig, outbox: Arc<IngressOutbox>) -> Self {
        Self {
            auth: Arc::new(config.bearer.clone()),
            project_roots: Arc::new(config.project_roots.clone()),
            public_url: Arc::from(config.bridge.bridge.public_url.deref()),
            // `RouterConfig` flattens `BridgeConfig` under a `bridge` field (see
            // `RouterConfig`'s own definition), so the configured agent_id is
            // `config.bridge.agent_id` -- not a field of `RouterConfig` itself.
            agent_id: Arc::from(config.bridge.agent_id.as_str()),
            outbox,
        }
    }

    /// The one place authentication happens.
    ///
    /// A method rather than a free function so that "every route is
    /// authenticated" is a property of the type and each handler has exactly one
    /// obvious call to omit. A handler that forgets is then a route that answers
    /// without ever having consulted `auth`.
    fn authenticate(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let presented = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok());
        if self.auth.accepts(presented) {
            Ok(())
        } else {
            Err(ApiError::Unauthorized)
        }
    }

    /// Commit `admission`, or refuse the request with a `503`.
    ///
    /// **The one place a store failure becomes a response.** A method on
    /// [`AppState`] rather than a free function so both admitting routes have
    /// exactly one call to make, the same reason [`AppState::authenticate`] is a
    /// method.
    ///
    /// The [`crate::outbox::StoreError`] is mapped away and discarded:
    /// `crate::error`'s rule is that no error body carries anything but a
    /// closed-set string, and a `rusqlite` message quoted into a response would be
    /// exactly the oracle that rule exists to prevent. The detail is not lost — it
    /// goes to stderr, which `main`'s startup path prints and this request path
    /// cannot reach without a logger this 4 MiB component does not have (M7.10 owns
    /// the destination).
    ///
    /// `?` at a point where the `202` has not been composed, which is the ordering
    /// `SF-08` requires: returning `Err` here cannot produce a `202` later in the
    /// handler, because there is no code after this point that builds one.
    fn admit(&self, admission: Admission) -> Result<(), ApiError> {
        self.outbox
            .admit(&admission, crate::outbox::now_ms())
            .map(|_| ())
            .map_err(|_| ApiError::StoreUnavailable)
    }
}

/// Build the router.
///
/// `fallback` is the catch-all, and it is where the two `/v1/mesh/*` paths are
/// answered. Handled here rather than by axum's default so the answer is a JSON
/// body carrying `schemaVersion` — an operator debugging a peer that "connected"
/// gets something to read — and so it is impossible for a future route added
/// without an auth check to be the thing that makes `/v1/mesh/terminal` reachable.
pub fn build(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/trigger", post(trigger))
        .route("/jobs/{id}", get(job))
        .route("/report", post(report))
        .fallback(not_found)
        .with_state(state)
}

/// `GET /health`.
///
/// # It does not call opencode
///
/// The engine's version returns `{"ok": true, "opencode": await health()}`
/// ([`src/server/routes/health.ts:5`](../../src/server/routes/health.ts)), which
/// makes a liveness probe depend on a second process being up. That is the right
/// answer for a process that *is* the bridge. It is the wrong answer for the
/// component that will sit in front of it: `aibr serve` being unreachable and
/// `opencode serve` being unreachable are different failures with different
/// responses, and collapsing them into one `ok: false` tells a supervisor to restart
/// the wrong process.
///
/// So this reports **the router's own liveness** — that it is bound, that its
/// runtime is scheduling, that its listening socket is accepting — and nothing else.
/// "Is the engine healthy" becomes the worker's question, answered by the worker,
/// over M7.7's queue health. `opencode` health is the worker's question too, and it
/// is asked at trigger time where the engine already asks it.
///
/// This is a semantic difference from the engine's route and it is intentional. It
/// is recorded in `Docs/implementation-reports/m7.3-progress.md` so the M7.7 cutover
/// does not discover it as a surprise.
///
/// Behind the bearer like everything else. A liveness probe that answers
/// unauthenticated tells an unauthenticated caller that this process is a live
/// AIBridge bridge, which is reconnaissance with no cost to the attacker — and the
/// engine's `/health` currently answers anyone who can reach the socket, because
/// `createApp()` installs no global auth hook. Enclosing it here is free: a
/// supervisor already holds the token.
///
/// # It also reports the queue, and it can fail
///
/// `M7.5`'s `queue` block is `depth`, `pending`, `sending`, `failed` and
/// `oldest_pending_age_ms` — [`crate::outbox::QueueStats`] verbatim, read inside
/// the response. Depth and oldest-age are the two numbers that together distinguish
/// a quiet queue from a stuck worker: a depth of 40 with an oldest age that has not
/// moved in ten minutes is a worker that died holding a claim, and neither number
/// says so alone.
///
/// `failed` is reported rather than hidden. A pile of retained terminal rows is the
/// plan's poison-payload row made visible to an operator, and a health endpoint
/// that omitted it would make a silently growing pile invisible.
///
/// **A store that cannot be read is a `503` here too**, and deliberately so: a
/// health endpoint that answered `200 {ok: true}` while the queue was unreadable is
/// exactly the "healthy empty queue" lie the store's module docs refuse. A
/// supervisor reading `503` restarts, which is the right response to a store this
/// process cannot use.
async fn health(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    state.authenticate(&headers)?;

    let stats = state
        .outbox
        .stats(crate::outbox::now_ms())
        .map_err(|_| ApiError::StoreUnavailable)?;

    Ok((
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "schemaVersion": CONTRACT_VERSION,
            "queue": {
                "depth": stats.depth,
                "pending": stats.pending,
                "sending": stats.sending,
                "failed": stats.failed,
                // `null` for an empty queue, which is the honest answer: there is no
                // oldest row, as opposed to an oldest row of age zero.
                "oldest_pending_age_ms": stats.oldest_pending_age_ms,
            }
        })),
    )
        .into_response())
}
/// `GET /jobs/{id}` — always `404`, and always after a charset check.
///
/// The `404` for a malformed id is deliberate and is *not* a shortcut. This
/// process has no job store, so it has no truthful `400` to give about an id it
/// cannot resolve: "no such job" and "no such id" are the same true statement
/// here. Answering `400` would claim a distinction the router has not earned, and
/// answering `200` with an error body would be worse.
///
/// The `F-01` reproduction is asserted against the charset function directly in
/// `validate::tests`, and against this route as "never a job, never a `200`".
async fn job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    state.authenticate(&headers)?;

    // The gate runs even though nothing downstream consumes the id. `F-01` is that
    // an unvalidated id reaches `join(directory, id + ".json")`; a route that
    // validated only "when it mattered" would stop validating the moment M7.7 wires
    // a store behind it, which is the change that makes the bug reachable.
    if !validate::valid_job_id(&id) {
        return Err(ApiError::NotFound);
    }

    Err(ApiError::NotFound)
}

/// `POST /trigger` — structural admission.
async fn trigger(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    state.authenticate(&headers)?;
    let bytes = capped_body(&headers, body).await?;

    let mut document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::InvalidPayload("request body must be valid JSON"))?;
    validate::envelope(&mut document)?;

    let trigger: TriggerRequest =
        validate::payload(&document, "request body is not a valid TriggerRequest")?;

    // `F-01` on the caller-supplied id.
    validate::check_optional_job_id(&trigger)?;

    // `F-04`: resolve symlinks, then require containment in a configured root.
    validate::canonical_project_dir(&trigger.project_dir, &state.project_roots)?;

    // Every gate has now run and every one of them refused. Nothing below this line
    // writes a row for a request that failed the structural gate, which is what keeps
    // `assertSourceAuthorized`'s refusal (a *worker* decision, §2.2) from having to
    // reason about rows it did not create.
    let job_id = match trigger.job_id.as_ref() {
        Some(supplied) => std::borrow::Cow::Borrowed(supplied.deref()),
        None => std::borrow::Cow::Owned(mint_job_id()?),
    };

    // The commit, and it happens before a single byte of the `202` below is
    // composed. `status_url` is still a string and not a link to anything this
    // process can serve — `GET /jobs/{id}` remains a `404` until M7.7 — but the
    // *job* it names is a committed row from here on, which is the part `SF-08` is
    // about.
    state.admit(Admission::trigger(
        &job_id,
        &job_id,
        &payload_json(&document),
    ))?;

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "accepted": true,
            "job_id": job_id,
            // Required by the committed triggerResponseSchema; see AppState::agent_id.
            "target_agent_id": state.agent_id.as_ref(),
            "status_url": format!("{}/jobs/{}", state.public_url, job_id),
            "schemaVersion": CONTRACT_VERSION,
        })),
    )
        .into_response())
}

/// `POST /report` — structural admission of an observation.
///
/// A report is an observation of what happened elsewhere. Recording one must not
/// fabricate a lifecycle event, which is why the engine's route correlates rather
/// than transitions ([`src/server/routes/report.ts:27`](../../src/server/routes/report.ts)).
/// Nothing about that changes here, because nothing about it runs here.
///
/// What M7.5 adds is the commit, keyed on the payload rather than on `job_id`: a
/// job produces several reports and they must not collapse into one row. See
/// [`Admission::report`].
async fn report(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    state.authenticate(&headers)?;
    let bytes = capped_body(&headers, body).await?;

    let mut document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::InvalidPayload("request body must be valid JSON"))?;
    validate::envelope(&mut document)?;

    // `F-01` again, on the same field from the other direction. A report names the
    // job it is about, and this is the path by which a peer-supplied string would
    // otherwise reach the same `join()`.
    let report: ReportCallback =
        validate::payload(&document, "request body is not a valid ReportCallback")?;
    validate::require_job_id(&report.job_id, "job_id must match [A-Za-z0-9_-]{1,128}")?;

    // Committed before the `202`, exactly as on `/trigger`. The `202` body carries no
    // job id, so this is the one route where a caller cannot correlate its own
    // submission — it is the peer's report about *this router's* job, and the
    // worker is what correlates it.
    state.admit(Admission::report(&report.job_id, &payload_json(&document)))?;

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "accepted": true, "schemaVersion": CONTRACT_VERSION })),
    )
        .into_response())
}

/// The catch-all. Also the answer for `/v1/mesh/terminal` and `/v1/mesh/events`.
async fn not_found() -> Response {
    ApiError::NotFound.into_response()
}

/// Buffer at most [`MAX_BODY_BYTES`], and report an overrun as `413`.
///
/// The two checks are not redundant. The `Content-Length` check rejects an honest
/// client before a single body byte is buffered or allocated, which matters
/// because the router's memory ceiling is 32 MiB and one unbounded body is a
/// denial of service that costs the attacker nothing. The `to_bytes` limit is what
/// holds when `Content-Length` is absent (chunked) or **lies** — a client is under
/// no obligation to report its body size correctly, so the header check is an
/// optimisation and the streaming limit is the control.
///
/// Hand-rolled rather than `DefaultBodyLimit` for one reason: it is the only way to
/// get the `413` into this crate's own [`ApiError`] vocabulary, so that every
/// refusal this process can produce shares one body shape. axum's default rejects
/// with a plain-text body, and a JSON API that answers in two formats is a JSON API
/// whose error handling nobody has tested.
async fn capped_body(headers: &HeaderMap, body: Body) -> Result<Bytes, ApiError> {
    if let Some(declared) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        if declared > MAX_BODY_BYTES {
            return Err(ApiError::PayloadTooLarge);
        }
    }

    axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| ApiError::PayloadTooLarge)
}

/// The admitted payload, as JSON: the re-serialised document with the envelope key
/// already removed.
///
/// **The re-serialised `document`, not the request bytes.** M7.7's worker re-parses
/// this against `triggerRequestSchema` / `reportCallbackSchema`, both of which
/// reject unknown keys, and `schemaVersion` is not a key of either payload — so
/// storing the raw bytes would store a document the worker cannot read. Storing
/// `document` also means the row holds a payload that is byte-identical for
/// identical requests, which is what lets a `/report` retry converge through
/// `ON CONFLICT` instead of arriving as a second row.
///
/// It cannot fail: the value was parsed from JSON a few lines earlier, so
/// serialising it back is infallible, and `serde_json::to_string` on a `Value`
/// allocates into a `String` rather than writing through a fallible writer.
fn payload_json(document: &serde_json::Value) -> String {
    // The only way `to_string` on a `Value` fails is a non-finite float, and this
    // document came out of `serde_json::from_slice`, which cannot produce one. So a
    // panic here is unreachable rather than merely unlikely, and the alternative --
    // threading a `Result` into both handlers for an error that cannot occur -- is
    // the one this codebase keeps refusing.
    serde_json::to_string(document).expect("a Value parsed from JSON re-serialises")
}

/// Mint an admission correlation token.
///
/// 16 bytes from the OS CSPRNG, hex-encoded: 32 characters, inside
/// [`validate::JOB_ID_MAX_LEN`] and inside the `F-01` charset, with 128 bits of
/// entropy.
///
/// **Predictable ids were rejected, not considered and skipped.** This string is
/// returned to a caller and handed back on `GET /jobs/{id}`. A counter, a
/// timestamp, or a hash of the request body would all produce an id another caller
/// could guess — and, once M7.7 makes that route real, a guessed id is a read of
/// someone else's trigger. The cost is one `getrandom(2)` on a path that is
/// already doing a `realpath` and a multi-megabyte-body parse.
///
/// Hex rather than base64: base64 uses `+` and `/`, and `/` is the byte `F-01` is
/// about. An id encoder that can emit the separator the finding describes would be
/// a poor place to economise.
fn mint_job_id() -> Result<String, ApiError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| ApiError::InvalidPayload("cannot allocate a job id"))?;

    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        // Infallible: writing two hex digits into a `String` with exactly twice
        // the reserved capacity cannot fail.
        let _ = write!(encoded, "{byte:02x}");
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::mint_job_id;
    use crate::validate::valid_job_id;

    #[test]
    fn minted_job_ids_are_usable_job_ids() {
        for _ in 0..64 {
            assert!(valid_job_id(
                &mint_job_id().expect("the OS CSPRNG is available")
            ));
        }
    }

    #[test]
    fn minted_job_ids_do_not_repeat() {
        // 64 ids from 128 bits. A collision here is a 64-bit birthday failure at
        // 2^-128; this asserts the function is actually drawing entropy rather
        // than returning a constant, which is the failure mode a broken
        // `getrandom` binding would produce.
        let ids: std::collections::HashSet<String> = (0..64)
            .map(|_| mint_job_id().expect("the OS CSPRNG is available"))
            .collect();
        assert_eq!(ids.len(), 64, "minted job ids repeated");
    }

    #[test]
    fn minted_job_ids_never_contain_a_path_separator() {
        for _ in 0..64 {
            let id = mint_job_id().expect("the OS CSPRNG is available");
            assert!(!id.contains('/'), "{id:?} contains a path separator");
            assert!(!id.contains('\\'), "{id:?} contains a path separator");
            assert!(!id.contains('.'), "{id:?} contains a dot");
        }
    }
}

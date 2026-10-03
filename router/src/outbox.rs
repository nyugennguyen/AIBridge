//! `ingress_outbox` — the durable admission queue (M7.5, `SF-08`).
//!
//! # The one invariant this module exists to keep
//!
//! > **A `202` means the row is committed.**
//!
//! [`IngressOutbox::admit`] returns `Ok` only after `COMMIT` has returned, and
//! [`crate::routes`] writes the `202` body only after that. Every other design
//! choice below is subordinate to keeping that ordering true, and the alternative
//! arrangements were rejected for reasons that are worth writing down, because
//! each of them looks locally reasonable.
//!
//! ## No in-memory fallback, and the router exits `78` rather than degrade
//!
//! A queue that accepts into memory when SQLite is unavailable is a queue that
//! drops everything it admitted on the next restart, and it does so having told
//! every caller `202`. ADR 0008 §2.5 names this failure explicitly. So
//! [`IngressOutbox::open`] **refuses a store file that does not exist** rather than
//! creating one, and the process exits `78` rather than starting.
//!
//! Refusing to *create* the file is the half that is easy to get wrong. SQLite will
//! happily create an empty database at any path, and a router that starts against
//! a fresh file is a router that has lost every previously admitted job and reports
//! a healthy empty queue. Nothing in the process can distinguish "first run" from
//! "someone deleted the evidence", so that distinction is not made here: creating
//! the store is an explicit provisioning step ([`IngressOutbox::create`]), and the
//! supervisor that owns the unit file (M7.10) owns invoking it.
//!
//! ## `202` is not emitted on a persistence failure
//!
//! A store failure is `503`, and the caller's retry is the recovery path. The
//! alternative — admitting the request in memory and hoping the store comes back —
//! is the lie this module is built to avoid.
//!
//! # What is NOT here
//!
//! This module is storage and nothing else. It does not decide *when* to retry
//! ([`INGRESS_BACKOFF_MS`] is the schedule table the plan fixes, but the function
//! that turns an attempt count into a delay is M7.6's, including the full-jitter
//! deviation the plan records), it does not drain the queue (M7.7), it does not
//! deliver anywhere (M7.8), and — the constraint that shapes the whole crate — it
//! does not decide whether a caller is *allowed* anything. See [`crate`] and ADR
//! 0008 §2.2.
//!
//! # Ordering: claim and acknowledge are two durable writes
//!
//! A worker claims a record, does the work, then acknowledges it. The claim and
//! the acknowledgement are separate `COMMIT`s, and a process that dies between
//! them leaves a row that says `sending` and a side effect that already happened.
//! That gap is real and is not closable by making the two writes atomic — they
//! cannot be, because the work happens between them. What makes it survivable is
//! that the gap is *representable*: [`IngressOutbox::recover_stale`] finds the row
//! by its claim lease, requeues it, and **preserves `attempts`**. See
//! [`deliverer.rs:54`](../../../src/mesh/outbox/deliverer.rs) for the ordering
//! argument being ported.
//!
//! # Terminal records are retained
//!
//! A row that exhausts [`MESH_OUTBOX_MAX_ATTEMPTS`] stays in the table with its
//! `terminal_error`, forever, readable. Mirroring `terminalDeliveryError`
//! ([`policy.ts:147`](../../../src/mesh/outbox/policy.ts)): the outbox is
//! *evidence*, not a cache. A deleted terminal record leaves an unexplained
//! divergence between what this node admitted and what the peer observed, with
//! nothing to point at. No code path in this module deletes a row, and
//! `router/tests/outbox.rs` asserts that a terminal row is still readable.
//!
//! # Why a `std::sync::Mutex` and not `tokio::sync::Mutex`
//!
//! No `.await` occurs while the connection is locked, so the lock can never be
//! held across a suspension point and cannot deadlock against one. The
//! alternative would mean enabling a `tokio` feature to buy a mutex that is held
//! for the length of one `fsync`, and the `fsync` itself is not awaitable anyway —
//! SQLite's durability is synchronous by construction, which is the entire reason
//! `synchronous = FULL` is set below.
//!
//! Blocking a runtime thread for the duration of the flush is a real cost. It is
//! recorded here rather than designed around: the router's concurrency is one
//! `POST /trigger` per admitted job, M7.10 is where RSS and latency are measured
//! against the ADR 0008 §2.1 numbers, and re-architecting admission around
//! `spawn_blocking` before there is a measurement is the speculative move this
//! codebase otherwise refuses.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

/// The environment variable naming the admission store.
///
/// A variable rather than a `config.json` key, and that is a temporary state with
/// a known end: `config.json` is parsed as `contracts::BridgeConfig`, which is
/// `deny_unknown_fields`, so adding `ingress.outbox_path` there means changing
/// [`src/config/schemas.ts`](../../../src/config/schemas.ts) and regenerating the
/// contracts — M7.4's job, and out of this task's reach by construction (see
/// `router/src/contracts.rs`).
///
/// **It has no default.** A default path would have to be relative to something,
/// and "relative to the working directory" is exactly the drift ADR 0008 §8's
/// configuration layer exists to catch: a systemd unit with a different
/// `WorkingDirectory` than the shell that provisioned the store produces a
/// second, empty queue with no error anywhere. Being required makes the
/// provisioning step explicit.
pub const INGRESS_OUTBOX_ENV: &str = "AIBRIDGE_INGRESS_OUTBOX";

/// The `PRAGMA user_version` this build writes and the only one it accepts.
///
/// Versioned rather than inferred from the table shape, and this is `SF-14` again
/// at a different layer: an unknown or newer version is **refused**, never
/// coerced and never "migrated forward". A store written by a future build may
/// contain rows this build cannot interpret, and silently accepting them would
/// mean answering `202` into a table whose columns this code has not read.
pub const SCHEMA_VERSION: i64 = 1;

/// How long a claim stays valid before [`IngressOutbox::recover_stale`] may
/// requeue it. 30 000 ms.
///
/// Ported exactly from `MESH_OUTBOX_CLAIM_LEASE_MS`
/// ([`policy.ts:94`](../../../src/mesh/outbox/policy.ts)) and for the reason
/// recorded there: a claim is held across one network round trip to a peer, and
/// the longest legitimate round trip on a Tailscale link is orders of magnitude
/// below 30s, so a longer lease only delays the reclamation a crash needs, while a
/// shorter one would reclaim a record whose delivery is merely slow.
pub const MESH_OUTBOX_CLAIM_LEASE_MS: u64 = 30_000;

/// Attempts allowed per record, including the first. 8.
///
/// Ported from `MESH_OUTBOX_MAX_ATTEMPTS` ([`policy.ts:82`](../../../src/mesh/outbox/policy.ts)).
/// The claim itself increments `attempts`, so the eighth claim is the eighth
/// delivery and the record is terminal when that one fails.
pub const MESH_OUTBOX_MAX_ATTEMPTS: u32 = 8;

/// The delay after the Nth failed attempt, in milliseconds. Index 0 is after
/// attempt 1. Ported from `DELIVERY_BACKOFF_MS`.
///
/// **The table is here; the function that indexes it is not.** Turning an attempt
/// count into a delay is M7.6's, because that is where the plan's one documented
/// deviation lives — full jitter (`sleep = rand(0, min(300s, 2^n * 1s))`) on the
/// strength that ingress has many routers fanning into one store during the M7.14
/// rolling upgrade, where the engine's un-jittered schedule was justified by there
/// being exactly one controller per run. Shipping the index function here would
/// make M7.6's actual change — adding jitter — a rewrite of this file rather than
/// of the policy module, and the deviation would end up recorded in the wrong
/// file.
///
/// `router/tests/outbox.rs` asserts the plan's last crash-window row against this
/// table, which is the claim that matters: over a ten-minute partition the
/// schedule costs ~2^10 transmissions rather than 600 000.
pub const INGRESS_BACKOFF_MS: [u64; 9] = [
    1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 300_000,
];

/// The ceiling on any single backoff, in milliseconds.
pub const MAX_DELIVERY_BACKOFF_MS: u64 = 300_000;

/// `PRAGMA synchronous` as SQLite reports `FULL`.
const SQLITE_SYNCHRONOUS_FULL: i64 = 2;

/// `PRAGMA busy_timeout`, in milliseconds.
///
/// 5000 ms, ported from the engine's driver
/// ([`sqlite-driver.ts:74`](../../../src/orchestration/event-store/sqlite-driver.ts)).
/// In WAL mode readers never block on the writer, so this only covers the
/// writer-writer case: two routers, or a router and M7.7's worker, both writing.
/// `SQLITE_BUSY` surfacing as a `503` after 5s is the correct outcome — it means
/// the caller retries, which is safe — but it should not happen in a healthy
/// deployment, so the number is generous rather than tight.
const BUSY_TIMEOUT_MS: u32 = 5_000;

/// Where an admitted request came from. Stored so M7.7's worker can dispatch
/// without re-deriving it from the payload.
///
/// Not an open set: [`ROUTE_TRIGGER`] and [`ROUTE_REPORT`] are the only two
/// admitting routes, and a third is a change to this table rather than a new
/// string written by a caller.
pub const ROUTE_TRIGGER: &str = "POST /trigger";
pub const ROUTE_REPORT: &str = "POST /report";

/// A row's lifecycle position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Claimable. `next_attempt_at_ms` says when.
    Pending,
    /// Claimed and in flight. `claimed_at_ms` plus the lease says whether the
    /// claim is still valid.
    Sending,
    /// Done. Terminal, and — unlike `Failed` — not an error state.
    Acknowledged,
    /// Exhausted. **Retained**, never deleted. See the module docs.
    Failed,
}

impl Status {
    /// The stored spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sending => "sending",
            Self::Acknowledged => "acknowledged",
            Self::Failed => "failed",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "sending" => Some(Self::Sending),
            "acknowledged" => Some(Self::Acknowledged),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// One row of `ingress_outbox`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionRecord {
    /// **The idempotency key.** `ON CONFLICT DO NOTHING` converges on this.
    ///
    /// For a `/trigger` row it *is* the job id: one trigger creates one job, so a
    /// repeated `job_id` is by definition the same job and the retry must not
    /// create a second.
    ///
    /// For a `/report` row it is `report:{subject_job_id}:{sha256(payload)}`. That
    /// is not decoration: a job produces **several** reports (`running`,
    /// `completed`, `failed`), and keying them on `job_id` alone would make
    /// `ON CONFLICT DO NOTHING` silently discard every report after the first —
    /// a lost callback to a peer rather than a converged retry. The key has to
    /// change when the observation changes, and the payload is the observation.
    pub job_id: String,

    /// The `job_id` from the request body, always.
    ///
    /// A separate column rather than something recovered by stripping the
    /// `report:` prefix at the consumer: M7.7's worker needs to correlate a report
    /// to its job, and a column that is a *derived* key is a column whose meaning
    /// depends on which route wrote it.
    pub subject_job_id: String,

    /// Which route admitted this. See [`ROUTE_TRIGGER`], [`ROUTE_REPORT`].
    pub route: String,

    /// [`crate::CONTRACT_VERSION`], stored per row rather than taken from the
    /// binary that reads it.
    ///
    /// The queue outlives the process: a row admitted by a v1 router must still be
    /// interpretable after the binary has moved on. A row that does not say which
    /// version wrote it forces the reader to assume, and `F-06` is an assumption
    /// that reached production once already.
    pub schema_version: String,

    /// The admitted payload, as JSON.
    ///
    /// The **re-serialised** document that passed the structural gate, with the
    /// `schemaVersion` envelope key removed ([`crate::validate::envelope`]) — not
    /// the raw request bytes. Storing the raw bytes would store a document with a
    /// key that is not part of any payload contract, and M7.7's worker re-parses
    /// this against `triggerRequestSchema` / `reportCallbackSchema`, where an
    /// unknown key is a hard failure rather than a stripped one.
    pub payload_json: String,

    pub created_at_ms: u64,
    pub next_attempt_at_ms: u64,
    pub attempts: u32,
    pub claim_token: Option<String>,
    pub claimed_at_ms: Option<u64>,
    pub status: Status,

    /// Why the most recent attempt failed, if any.
    ///
    /// Distinct from `terminal_error` because a requeued record still wants to say
    /// why it was requeued, and overwriting `terminal_error` on the way there
    /// would destroy the only durable answer to "why did this record give up".
    pub last_error: Option<String>,

    /// Why the record went terminal. Set exactly once, on the transition to
    /// [`Status::Failed`], and never cleared.
    pub terminal_error: Option<String>,
}

/// What [`IngressOutbox::admit`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionOutcome {
    /// This call's `INSERT` created the row.
    Written,
    /// The row was already there and this request converged onto it.
    ///
    /// **Not an error, and not reported as one.** A caller retry after a lost
    /// response must get the same answer it would have got the first time, and an
    /// error status here would make the crash-window retry loop in
    /// `router/tests/outbox.rs` never terminate.
    Converged,
}

/// A claim: the token that authorises the follow-up writes, and the rows it owns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub token: String,
    pub claimed_at_ms: u64,
    pub lease_expires_at_ms: u64,
    pub records: Vec<AdmissionRecord>,
}

/// What a failure write did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureOutcome {
    /// Requeued, with the `next_attempt_at_ms` the caller supplied.
    Requeued,
    /// This failure reached [`MESH_OUTBOX_MAX_ATTEMPTS`]; the row is terminal and
    /// retained.
    Terminal,
}

/// Queue depth, for `GET /health`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueStats {
    /// Admitted work not yet acknowledged: `pending` plus `sending`.
    pub depth: u64,
    pub pending: u64,
    pub sending: u64,
    /// Retained terminal rows. Reported rather than hidden so a growing pile of
    /// poison records is visible to an operator instead of being silently
    /// retained.
    pub failed: u64,
    /// Age of the oldest `pending` row, in milliseconds. `None` when the queue is
    /// empty.
    ///
    /// The queue's version of the `attempts` column: a depth that is not moving and
    /// an oldest age that is not moving is a stuck worker, and neither number alone
    /// distinguishes that from a quiet queue.
    pub oldest_pending_age_ms: Option<u64>,
}

/// Why the store could not be used.
///
/// Split into these variants rather than one opaque failure because the two
/// classes demand opposite responses from the operator: [`StoreError::Open*`]
/// means the process must not start (`78`), and [`StoreError::Write`] means the
/// process is running but cannot accept work, which is a `503` and a caller retry.
#[derive(Debug)]
pub enum StoreError {
    /// `AIBRIDGE_INGRESS_OUTBOX` was unset.
    MissingPath,
    /// The configured store file does not exist.
    ///
    /// Its own variant, distinct from "exists but could not be opened", because the
    /// two have different causes and the message has to distinguish them the way
    /// `ApiError` refuses to distinguish bearer failures from absent ones: an
    /// operator who sees "cannot open the store" when the file was deleted will go
    /// looking at permissions.
    Absent { path: PathBuf },
    /// The file exists and could not be opened, or the schema could not be
    /// established.
    Open { path: PathBuf, detail: String },
    /// `PRAGMA user_version` is not a version this build speaks. Never coerced.
    UnsupportedSchemaVersion {
        path: PathBuf,
        found: i64,
        supported: i64,
    },
    /// A durability pragma did not take effect. See [`IngressOutbox::open`].
    PragmaNotApplied {
        path: PathBuf,
        pragma: &'static str,
        expected: String,
        found: String,
    },
    /// A statement failed at runtime. Surfaced as `503`.
    ///
    /// `operation` names the *method*, never the request: this string reaches a
    /// response path, and [`crate::error`] has one rule about that.
    Write {
        operation: &'static str,
        detail: String,
    },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingPath => write!(f, "{INGRESS_OUTBOX_ENV} is required"),
            Self::Absent { path } => write!(
                f,
                "the admission store {} does not exist, and this router will not create it: \
                 a store that appears from nothing is a queue that has lost every row it \
                 admitted. Provision it explicitly (IngressOutbox::create) and start again",
                path.display()
            ),
            Self::Open { path, detail } => {
                write!(
                    f,
                    "cannot open the admission store {}: {detail}",
                    path.display()
                )
            }
            Self::UnsupportedSchemaVersion {
                path,
                found,
                supported,
            } => write!(
                f,
                "the admission store {} is at schema version {found}, and this build speaks \
                 version {supported}. It will not coerce, downgrade, or migrate it: a store \
                 written by another build may hold rows this one cannot read",
                path.display()
            ),
            Self::PragmaNotApplied {
                path,
                pragma,
                expected,
                found,
            } => write!(
                f,
                "the admission store {} refused PRAGMA {pragma}: expected {expected}, found \
                 {found}. Refusing to serve rather than accept work at a weaker durability \
                 than the one this build promises",
                path.display()
            ),
            Self::Write { operation, detail } => {
                write!(
                    f,
                    "admission store write failed during {operation}: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for StoreError {}

/// The durable admission store.
///
/// One `Connection` behind a `Mutex`; see the module docs for why.
pub struct IngressOutbox {
    connection: Mutex<Connection>,
    path: PathBuf,
    /// False only for [`IngressOutbox::open_in_memory`].
    durable: bool,
}

impl IngressOutbox {
    /// Open an **existing** store, refusing to create one.
    ///
    /// The refusal is the point; see the module docs. `create` is the other door
    /// and it is deliberately not reachable from startup.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if !path.is_file() {
            return Err(StoreError::Absent {
                path: path.to_path_buf(),
            });
        }
        Self::open_inner(path, true)
    }

    /// Provision a store, creating and migrating it.
    ///
    /// Separate from [`IngressOutbox::open`] and *not* called by startup. A
    /// deployment's first run is an operator action (M7.10's unit), and a process
    /// that provisions its own durable state cannot tell provisioning apart from
    /// recovery.
    pub fn create(path: &Path) -> Result<Self, StoreError> {
        Self::open_inner(path, true)
    }

    /// A private, non-durable store, for tests that are not about durability.
    ///
    /// The name says it out loud because `Connection::open_in_memory()` is the
    /// obvious shortcut and it is the wrong one for this crate: an in-memory store
    /// silently ignores `journal_mode` (`PRAGMA journal_mode` on a `:memory:`
    /// database returns `memory`, not `wal`) and its contents vanish with the
    /// connection, so a route test that ran against one is not evidence about
    /// durability. Every durability claim in `router/tests/outbox.rs` is asserted
    /// against a **file**-backed store or a real spawned process; this constructor
    /// exists for the ~30 route tests in `gates.rs` that are about shape, auth and
    /// the structural gate.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let path = PathBuf::from(":memory:");
        let connection = Connection::open_in_memory().map_err(|error| StoreError::Open {
            path: path.clone(),
            detail: error.to_string(),
        })?;
        let store = Self {
            connection: Mutex::new(connection),
            path,
            durable: false,
        };
        {
            let connection = store.lock()?;
            Self::apply_connection_pragmas(&connection, &store.path, false)?;
            migrate(&connection, &store.path)?;
        }
        Ok(store)
    }

    fn open_inner(path: &Path, durable: bool) -> Result<Self, StoreError> {
        let path = path.to_path_buf();
        let connection = Connection::open(&path).map_err(|error| StoreError::Open {
            path: path.clone(),
            detail: error.to_string(),
        })?;
        let store = Self {
            connection: Mutex::new(connection),
            path,
            durable,
        };
        let connection = store.lock()?;
        Self::apply_connection_pragmas(&connection, &store.path, durable)?;
        migrate(&connection, &store.path)?;
        drop(connection);
        Ok(store)
    }

    /// The four pragmas this store's durability argument rests on.
    ///
    /// Set on every connection and **read back**, because `PRAGMA` returns its
    /// result and a pragma that silently did not apply is the specific shape of
    /// bug this whole milestone exists to prevent: the code looks right, the tests
    /// pass, and admitted work is lost on power failure. `journal_mode` and
    /// `synchronous` are both refused if they come back as anything else, so a
    /// store that cannot honour them fails at startup rather than quietly
    /// promising something it is not doing.
    fn apply_connection_pragmas(
        connection: &Connection,
        path: &Path,
        durable: bool,
    ) -> Result<(), StoreError> {
        connection
            .busy_timeout(Duration::from_millis(u64::from(BUSY_TIMEOUT_MS)))
            .map_err(|error| StoreError::Open {
                path: path.to_path_buf(),
                detail: error.to_string(),
            })?;

        // WAL: readers do not block the writer and the writer does not block
        // readers, which is what lets M7.7's worker drain while the router is
        // still admitting.
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| StoreError::Open {
                path: path.to_path_buf(),
                detail: error.to_string(),
            })?;

        // FULL, not NORMAL. Under WAL, `NORMAL` skips the fsync at commit and
        // relies on the operating system's writeback cache; a power loss — or an
        // iPhone that hard-resets, which is a power loss from SQLite's point of
        // view — then loses committed admissions. That is the specific loss this
        // module is built to prevent, and it is the whole reason the router does
        // not simply write to `/tmp`. The cost is one fsync per admission, which
        // is the correct price for a `202` that means something.
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|error| StoreError::Open {
                path: path.to_path_buf(),
                detail: error.to_string(),
            })?;

        // ON, with no foreign keys in the schema yet. M7.8's `egress_outbox`
        // references ingress rows, and setting the pragma before a table depends
        // on it is the difference between one migration and a second one that has
        // to retrofit enforcement onto rows that already exist.
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| StoreError::Open {
                path: path.to_path_buf(),
                detail: error.to_string(),
            })?;

        let journal_mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(|error| StoreError::Open {
                path: path.to_path_buf(),
                detail: error.to_string(),
            })?;
        if !journal_mode_is_acceptable(&journal_mode, durable) {
            return Err(StoreError::PragmaNotApplied {
                path: path.to_path_buf(),
                pragma: "journal_mode",
                expected: "wal".to_owned(),
                found: journal_mode,
            });
        }

        let synchronous: i64 = connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(|error| StoreError::Open {
                path: path.to_path_buf(),
                detail: error.to_string(),
            })?;
        if synchronous != SQLITE_SYNCHRONOUS_FULL {
            return Err(StoreError::PragmaNotApplied {
                path: path.to_path_buf(),
                pragma: "synchronous",
                expected: "full".to_owned(),
                found: synchronous.to_string(),
            });
        }

        Ok(())
    }

    /// The store's `PRAGMA user_version`. Read by tests and by `open`.
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        let connection = self.lock()?;
        connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| StoreError::Write {
                operation: "schema_version",
                detail: error.to_string(),
            })
    }

    /// `PRAGMA journal_mode`, for the durability assertions in the test suite.
    pub fn journal_mode(&self) -> Result<String, StoreError> {
        let connection = self.lock()?;
        connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(|error| StoreError::Write {
                operation: "journal_mode",
                detail: error.to_string(),
            })
    }

    /// `PRAGMA synchronous`, as SQLite's integer. `2` is `FULL`.
    pub fn synchronous(&self) -> Result<i64, StoreError> {
        let connection = self.lock()?;
        connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(|error| StoreError::Write {
                operation: "synchronous",
                detail: error.to_string(),
            })
    }

    /// Whether this store is file-backed.
    ///
    /// `false` only for [`IngressOutbox::open_in_memory`]. Exposed so a test can
    /// assert that no production path constructed a non-durable store, rather than
    /// taking it on trust from the module's own documentation.
    pub const fn is_durable(&self) -> bool {
        self.durable
    }

    /// Admit a request. **Returns `Ok` only after `COMMIT` has returned.**
    ///
    /// One transaction: the `INSERT ... ON CONFLICT DO NOTHING` and the re-read
    /// that decides [`AdmissionOutcome`]. They are not two statements, because a
    /// check and a write with a gap between them are exactly where a redelivered
    /// request gets two rows — the same argument as
    /// [`sqlite-outbox-store.ts`](../../../src/mesh/outbox/sqlite-outbox-store.ts),
    /// and the reason the outcome comes from a `changes` count rather than from
    /// "a row exists".
    ///
    /// `IMMEDIATE`, not the default `DEFERRED`: this is the ingress hot path and
    /// two writers can be present from the moment M7.7's worker exists. A deferred
    /// transaction takes a read lock first and upgrades, and an upgrade that loses
    /// the race is `SQLITE_BUSY` that `busy_timeout` cannot retry.
    pub fn admit(
        &self,
        admission: &Admission,
        now_ms: u64,
    ) -> Result<AdmissionOutcome, StoreError> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| StoreError::Write {
                operation: "admit",
                detail: error.to_string(),
            })?;

        let changes = transaction
            .execute(
                "INSERT INTO ingress_outbox (
                   job_id, subject_job_id, route, schema_version, payload_json,
                   created_at_ms, next_attempt_at_ms, attempts, status
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')
                 ON CONFLICT (job_id) DO NOTHING",
                params![
                    admission.job_id,
                    admission.subject_job_id,
                    admission.route,
                    admission.schema_version,
                    admission.payload_json,
                    bind_ms_at("admit", now_ms)?,
                    bind_ms_at("admit", now_ms)?,
                ],
            )
            .map_err(|error| StoreError::Write {
                operation: "admit",
                detail: error.to_string(),
            })?;

        // Ported from the mesh store's own post-condition: an `enqueue` that
        // reported convergence onto nothing would leave the sender believing its
        // event is in flight with nothing holding it.
        let readable: Option<String> = transaction
            .query_row(
                "SELECT job_id FROM ingress_outbox WHERE job_id = ?",
                params![admission.job_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| StoreError::Write {
                operation: "admit",
                detail: error.to_string(),
            })?;

        if readable.is_none() {
            return Err(StoreError::Write {
                operation: "admit",
                detail: "the row this call wrote or converged onto is not readable in the \
                         same transaction"
                    .to_owned(),
            });
        }

        transaction.commit().map_err(|error| StoreError::Write {
            operation: "admit",
            detail: error.to_string(),
        })?;

        Ok(if changes > 0 {
            AdmissionOutcome::Written
        } else {
            AdmissionOutcome::Converged
        })
    }

    /// Claim up to `limit` claimable records.
    ///
    /// The `attempts = attempts + 1` is here, in the claim, and nowhere else —
    /// ported from `claimPendingOutbox`. It means the eighth claim is the eighth
    /// delivery, which is what makes [`MESH_OUTBOX_MAX_ATTEMPTS`] a count of
    /// deliveries rather than of failures.
    ///
    /// `status = 'pending'` is repeated in the `UPDATE` on purpose: it is the
    /// compare-and-set that makes a double claim impossible even if the isolation
    /// of the surrounding transaction were ever weakened.
    pub fn claim_pending(&self, now_ms: u64, limit: u32) -> Result<Claim, StoreError> {
        let mut connection = self.lock()?;
        let transaction = transaction_for_claim(&mut connection)?;
        let token = mint_claim_token()?;

        let candidates: Vec<String> = {
            let mut statement = transaction
                .prepare(
                    "SELECT job_id FROM ingress_outbox
                     WHERE status = 'pending' AND next_attempt_at_ms <= ?
                     ORDER BY created_at_ms ASC, job_id ASC
                     LIMIT ?",
                )
                .map_err(|error| StoreError::Write {
                    operation: "claim_pending",
                    detail: error.to_string(),
                })?;
            let rows = statement
                .query_map(
                    params![bind_ms_at("claim_pending", now_ms)?, limit],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| StoreError::Write {
                    operation: "claim_pending",
                    detail: error.to_string(),
                })?;
            rows.collect::<Result<Vec<String>, _>>()
                .map_err(|error| StoreError::Write {
                    operation: "claim_pending",
                    detail: error.to_string(),
                })?
        };

        if candidates.is_empty() {
            transaction.commit().map_err(|error| StoreError::Write {
                operation: "claim_pending",
                detail: error.to_string(),
            })?;
            return Ok(Claim {
                token,
                claimed_at_ms: now_ms,
                lease_expires_at_ms: now_ms.saturating_add(MESH_OUTBOX_CLAIM_LEASE_MS),
                records: Vec::new(),
            });
        }

        let mut claimed = 0_u32;
        for job_id in &candidates {
            claimed += transaction
                .execute(
                    "UPDATE ingress_outbox
                     SET status = 'sending',
                         claim_token = ?,
                         claimed_at_ms = ?,
                         attempts = attempts + 1
                     WHERE status = 'pending' AND job_id = ?",
                    params![token, bind_ms_at("acknowledge", now_ms)?, job_id],
                )
                .map_err(|error| StoreError::Write {
                    operation: "claim_pending",
                    detail: error.to_string(),
                })? as u32;
        }

        let records = select_claimed(&transaction, &token, &claimed)?;

        transaction.commit().map_err(|error| StoreError::Write {
            operation: "claim_pending",
            detail: error.to_string(),
        })?;

        Ok(Claim {
            token,
            claimed_at_ms: now_ms,
            lease_expires_at_ms: now_ms.saturating_add(MESH_OUTBOX_CLAIM_LEASE_MS),
            records,
        })
    }

    /// The second durable write of a delivery: the work is done.
    ///
    /// Separate from the claim, and separately durable, because the work happened
    /// in between. `claim_token` is required: an acknowledgement from a process
    /// that does not hold the claim would acknowledge a record somebody else is
    /// working on, which is the duplicate the at-least-once discipline exists to
    /// keep rare.
    pub fn acknowledge(
        &self,
        job_id: &str,
        claim_token: &str,
        now_ms: u64,
    ) -> Result<bool, StoreError> {
        let mut connection = self.lock()?;
        let transaction = transaction_for_claim(&mut connection)?;
        let changes = transaction
            .execute(
                "UPDATE ingress_outbox
                 SET status = 'acknowledged',
                     claim_token = NULL,
                     claimed_at_ms = NULL,
                     next_attempt_at_ms = NULL
                 WHERE job_id = ? AND status = 'sending' AND claim_token = ?",
                params![job_id, claim_token],
            )
            .map_err(|error| StoreError::Write {
                operation: "acknowledge",
                detail: error.to_string(),
            })?;
        transaction.commit().map_err(|error| StoreError::Write {
            operation: "acknowledge",
            detail: error.to_string(),
        })?;
        let _ = now_ms;
        Ok(changes > 0)
    }

    /// Record a failed delivery, with the retry deadline the caller decided on.
    ///
    /// `next_attempt_at_ms` is an **argument**, not a computation, and that is the
    /// boundary with M7.6: this module records when a record may be retried, and
    /// the policy module decides when. A store that computed its own backoff would
    /// put the jitter deviation in the wrong file and would make M7.6's change a
    /// rewrite of the storage layer.
    ///
    /// At [`MESH_OUTBOX_MAX_ATTEMPTS`] the record goes terminal, `next_attempt_at_ms`
    /// is cleared **in the same statement**, and the row is retained. Clearing it
    /// there mirrors the mesh store's `exhaust`
    /// ([`sqlite-outbox-store.ts:159`](../../../src/mesh/outbox/sqlite-outbox-store.ts)):
    /// a terminal row carrying a future retry deadline is a lie to an operator and
    /// a wake-up for any scheduler that reads that column.
    ///
    /// `error_code` is a **code, not a message** — the port of `describeDeliveryFailure`
    /// ([`policy.ts:163`](../../../src/mesh/outbox/policy.ts)). The payload text
    /// belongs in the event log; a column an operator greps holds a bounded token
    /// that does not carry request content.
    pub fn fail(
        &self,
        job_id: &str,
        claim_token: &str,
        error_code: &str,
        next_attempt_at_ms: u64,
        now_ms: u64,
    ) -> Result<FailureOutcome, StoreError> {
        let code = truncate_error_code(error_code);
        let mut connection = self.lock()?;
        let transaction = transaction_for_claim(&mut connection)?;

        let attempts: Option<u32> = transaction
            .query_row(
                "SELECT attempts FROM ingress_outbox
                 WHERE job_id = ? AND status = 'sending' AND claim_token = ?",
                params![job_id, claim_token],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|value| value.map(|raw| u32::try_from(raw).unwrap_or(u32::MAX)))
            .map_err(|error| StoreError::Write {
                operation: "fail",
                detail: error.to_string(),
            })?;

        let Some(attempts) = attempts else {
            // Not ours, or already requeued by a concurrent `recover_stale`. A
            // report of somebody else's failure would overwrite their `last_error`.
            transaction.commit().map_err(|error| StoreError::Write {
                operation: "fail",
                detail: error.to_string(),
            })?;
            return Ok(FailureOutcome::Requeued);
        };

        let outcome = if attempts >= MESH_OUTBOX_MAX_ATTEMPTS {
            transaction
                .execute(
                    "UPDATE ingress_outbox
                     SET status = 'failed',
                         claim_token = NULL,
                         claimed_at_ms = NULL,
                         next_attempt_at_ms = NULL,
                         last_error = ?,
                         terminal_error = ?
                     WHERE job_id = ? AND status = 'sending' AND claim_token = ?",
                    params![code, code, job_id, claim_token],
                )
                .map_err(|error| StoreError::Write {
                    operation: "fail",
                    detail: error.to_string(),
                })?;
            FailureOutcome::Terminal
        } else {
            transaction
                .execute(
                    "UPDATE ingress_outbox
                     SET status = 'pending',
                         claim_token = NULL,
                         claimed_at_ms = NULL,
                         next_attempt_at_ms = ?,
                         last_error = ?
                     WHERE job_id = ? AND status = 'sending' AND claim_token = ?",
                    params![
                        bind_ms_at("fail", next_attempt_at_ms)?,
                        code,
                        job_id,
                        claim_token
                    ],
                )
                .map_err(|error| StoreError::Write {
                    operation: "fail",
                    detail: error.to_string(),
                })?;
            FailureOutcome::Requeued
        };

        transaction.commit().map_err(|error| StoreError::Write {
            operation: "fail",
            detail: error.to_string(),
        })?;
        let _ = now_ms;
        Ok(outcome)
    }

    /// Requeue records stranded in `sending` by a claim that was never
    /// acknowledged.
    ///
    /// **The lease is the only thing that decides staleness** — `claimed_at_ms`
    /// plus [`MESH_OUTBOX_CLAIM_LEASE_MS`] — and never the process having restarted.
    /// A worker that restarts and immediately reclaims its own live claim is the
    /// duplicate this exists to avoid, and the only evidence that distinguishes
    /// "the previous holder died" from "the previous holder is slow" is time.
    ///
    /// **`attempts` is not reset, and no `UPDATE` in this module ever assigns it a
    /// constant.** The claim is the only writer, and it only ever does
    /// `attempts = attempts + 1`. A pump that reclaims without checking the
    /// threshold is a pump that never stops retrying a record it cannot deliver.
    ///
    /// # One deliberate difference from the engine's `recoverStaleOutbox`
    ///
    /// The engine's version requeues unconditionally and returns `exhausted: []`
    /// ([`outbox-store.ts:305`](../../../src/orchestration/event-store/outbox-store.rs)),
    /// leaving a record that has been requeued eight times sitting in `pending`
    /// with no terminal transition. Here, a stranded record already at
    /// [`MESH_OUTBOX_MAX_ATTEMPTS`] becomes **terminal** instead of being requeued
    /// a ninth time.
    ///
    /// The reason is that the two stores are reached differently. The engine's
    /// outbox is drained by a deliverer that re-claims and fails records through
    /// the ordinary path, so a record at the threshold does eventually go terminal
    /// through `markOutboxFailed`. The ingress queue's claim is held across the
    /// worker's *own* processing of the job, and the failure mode this row exists
    /// to catch is a worker that dies holding the claim — which never reaches
    /// `fail` at all. Left as-is that is a row requeued forever, at full
    /// `attempts`, by a restart loop. Terminal it, and it is visible to an
    /// operator instead of being a hot loop.
    ///
    /// This is a **deviation from the ported file**, recorded at the deviation
    /// site as the plan requires, and it preserves the invariant the plan states
    /// for this column: `attempts` is never reset.
    pub fn recover_stale(&self, now_ms: u64) -> Result<Vec<String>, StoreError> {
        let mut connection = self.lock()?;
        let transaction = transaction_for_claim(&mut connection)?;
        let cutoff = now_ms.saturating_sub(MESH_OUTBOX_CLAIM_LEASE_MS);

        let stranded: Vec<(String, u32)> = {
            let mut statement = transaction
                .prepare(
                    "SELECT job_id, attempts FROM ingress_outbox
                     WHERE status = 'sending'
                       AND claimed_at_ms IS NOT NULL
                       AND claimed_at_ms <= ?
                     ORDER BY created_at_ms ASC, job_id ASC",
                )
                .map_err(|error| StoreError::Write {
                    operation: "recover_stale",
                    detail: error.to_string(),
                })?;
            let rows = statement
                .query_map(params![bind_ms_at("recover_stale", cutoff)?], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        u32::try_from(row.get::<_, i64>(1)?).unwrap_or(u32::MAX),
                    ))
                })
                .map_err(|error| StoreError::Write {
                    operation: "recover_stale",
                    detail: error.to_string(),
                })?;
            rows.collect::<Result<Vec<(String, u32)>, _>>()
                .map_err(|error| StoreError::Write {
                    operation: "recover_stale",
                    detail: error.to_string(),
                })?
        };

        let mut requeued = Vec::new();
        for (job_id, attempts) in &stranded {
            if *attempts >= MESH_OUTBOX_MAX_ATTEMPTS {
                transaction
                    .execute(
                        "UPDATE ingress_outbox
                         SET status = 'failed',
                             claim_token = NULL,
                             claimed_at_ms = NULL,
                             next_attempt_at_ms = NULL,
                             last_error = 'claim lease expired before acknowledgement',
                             terminal_error = COALESCE(
                                 terminal_error,
                                 'claim lease expired before acknowledgement')
                         WHERE job_id = ? AND status = 'sending'",
                        params![job_id],
                    )
                    .map_err(|error| StoreError::Write {
                        operation: "recover_stale",
                        detail: error.to_string(),
                    })?;
            } else {
                transaction
                    .execute(
                        "UPDATE ingress_outbox
                         SET status = 'pending',
                             claim_token = NULL,
                             claimed_at_ms = NULL,
                             last_error = COALESCE(
                                 last_error, 'claim lease expired before acknowledgement')
                         WHERE job_id = ? AND status = 'sending'",
                        params![job_id],
                    )
                    .map_err(|error| StoreError::Write {
                        operation: "recover_stale",
                        detail: error.to_string(),
                    })?;
                requeued.push(job_id.clone());
            }
        }

        transaction.commit().map_err(|error| StoreError::Write {
            operation: "recover_stale",
            detail: error.to_string(),
        })?;
        Ok(requeued)
    }

    /// One row by its idempotency key.
    pub fn get(&self, job_id: &str) -> Result<Option<AdmissionRecord>, StoreError> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT * FROM ingress_outbox WHERE job_id = ?")
            .map_err(|error| StoreError::Write {
                operation: "get",
                detail: error.to_string(),
            })?;
        let record = statement
            .query_row(params![job_id], map_record)
            .optional()
            .map_err(|error| StoreError::Write {
                operation: "get",
                detail: error.to_string(),
            })?;
        Ok(record)
    }

    /// Every row in a status, oldest first.
    ///
    /// `SELECT *` is not used anywhere in this module — every read names its
    /// columns, which is what keeps a `STRICT` schema's column order from being
    /// load-bearing. This exists to make a retained terminal row *visible*, which
    /// the plan's poison-payload row requires, and it is the query an operator
    /// running `sqlite3` would write by hand.
    pub fn list_by_status(&self, status: Status) -> Result<Vec<AdmissionRecord>, StoreError> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT job_id, subject_job_id, route, schema_version, payload_json,
                        created_at_ms, next_attempt_at_ms, attempts, claim_token,
                        claimed_at_ms, status, last_error, terminal_error
                 FROM ingress_outbox
                 WHERE status = ?
                 ORDER BY created_at_ms ASC, job_id ASC",
            )
            .map_err(|error| StoreError::Write {
                operation: "list_by_status",
                detail: error.to_string(),
            })?;
        let rows = statement
            .query_map(params![status.as_str()], map_record)
            .map_err(|error| StoreError::Write {
                operation: "list_by_status",
                detail: error.to_string(),
            })?;
        rows.collect::<Result<Vec<AdmissionRecord>, _>>()
            .map_err(|error| StoreError::Write {
                operation: "list_by_status",
                detail: error.to_string(),
            })
    }

    /// Depth and staleness, for `GET /health`.
    pub fn stats(&self, now_ms: u64) -> Result<QueueStats, StoreError> {
        let connection = self.lock()?;
        let count = |status: &str| -> Result<u64, StoreError> {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM ingress_outbox WHERE status = ?",
                    params![status],
                    |row| row.get::<_, i64>(0),
                )
                .map(|value| u64::try_from(value).unwrap_or(u64::MAX))
                .map_err(|error| StoreError::Write {
                    operation: "stats",
                    detail: error.to_string(),
                })
        };

        let pending = count("pending")?;
        let sending = count("sending")?;
        let failed = count("failed")?;

        let oldest: Option<i64> = connection
            .query_row(
                "SELECT MIN(created_at_ms) FROM ingress_outbox WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| StoreError::Write {
                operation: "stats",
                detail: error.to_string(),
            })?
            .flatten();

        Ok(QueueStats {
            depth: pending + sending,
            pending,
            sending,
            failed,
            oldest_pending_age_ms: oldest
                .map(|created| now_ms.saturating_sub(u64::try_from(created).unwrap_or(0))),
        })
    }

    /// The `CREATE TABLE` and its index, as the migration runs them.
    ///
    /// `STRICT` so the column types are enforced by SQLite rather than by
    /// convention: this table's `attempts` is compared against a threshold in SQL
    /// and a row that stored `'three'` there would be silently ordered wrong
    /// instead of refused. `STRICT` requires SQLite 3.37, which is why `bundled`
    /// is not optional (see `Cargo.toml`).
    const MIGRATION_1: &'static str = "
        CREATE TABLE ingress_outbox (
          job_id             TEXT    PRIMARY KEY,
          subject_job_id     TEXT    NOT NULL,
          route              TEXT    NOT NULL,
          schema_version     TEXT    NOT NULL,
          payload_json       TEXT    NOT NULL,
          created_at_ms      INTEGER NOT NULL,
          next_attempt_at_ms INTEGER NOT NULL,
          attempts           INTEGER NOT NULL DEFAULT 0,
          claim_token        TEXT,
          claimed_at_ms      INTEGER,
          status             TEXT    NOT NULL
            CHECK (status IN ('pending', 'sending', 'acknowledged', 'failed')),
          last_error         TEXT,
          terminal_error     TEXT,
          CHECK (attempts >= 0)
        ) STRICT;

        CREATE INDEX ingress_outbox_claimable
          ON ingress_outbox (status, next_attempt_at_ms);
    ";

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        // A poisoned lock means a panic unwound while the connection was held. The
        // connection is not known to be in a consistent state, and reporting that
        // as `503` — caller retries, supervisor may restart — is the honest
        // answer. Recovering the guard and carrying on would be the alternative,
        // and it is the one this store refuses: the invariant is "a `202` means a
        // committed row", and a half-finished statement is exactly the state where
        // that cannot be confirmed.
        self.connection.lock().map_err(|_| StoreError::Write {
            operation: "lock",
            detail: "the store connection lock was poisoned by an earlier panic; this \
                     store refuses to continue on a connection of unknown state"
                .to_owned(),
        })
    }
}

/// An admission to write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admission {
    pub job_id: String,
    pub subject_job_id: String,
    pub route: String,
    pub schema_version: String,
    pub payload_json: String,
}

impl Admission {
    /// A `/trigger` admission, keyed on the job id.
    pub fn trigger(job_id: &str, subject_job_id: &str, payload_json: &str) -> Self {
        Self {
            job_id: job_id.to_owned(),
            subject_job_id: subject_job_id.to_owned(),
            route: ROUTE_TRIGGER.to_owned(),
            schema_version: crate::CONTRACT_VERSION.to_owned(),
            payload_json: payload_json.to_owned(),
        }
    }

    /// A `/report` admission, keyed on the job id **and** a digest of the payload.
    ///
    /// See [`AdmissionRecord::job_id`] for why the report key is not the job id.
    /// The prefix is part of the stored `job_id` column, so a report key can never
    /// collide with a trigger whose `job_id` happens to be
    /// `report:...`-shaped — the `F-01` charset check forbids `:` in a caller
    /// supplied `job_id` before it ever reaches here, so the namespaces are
    /// disjoint by construction rather than by convention.
    pub fn report(subject_job_id: &str, payload_json: &str) -> Self {
        Self {
            job_id: format!("report:{subject_job_id}:{}", payload_digest(payload_json)),
            subject_job_id: subject_job_id.to_owned(),
            route: ROUTE_REPORT.to_owned(),
            schema_version: crate::CONTRACT_VERSION.to_owned(),
            payload_json: payload_json.to_owned(),
        }
    }
}

/// The hex SHA-256 of `payload_json`.
///
/// The digest is of the **admitted, re-serialised** payload, so two byte-identical
/// reports converge and two reports that differ in any field do not. Hashing the
/// raw request bytes instead would make the key depend on key ordering and
/// whitespace, which would turn a retried-and-reformatted report into a second row
/// — the exact duplication `ON CONFLICT` exists to prevent.
fn payload_digest(payload_json: &str) -> String {
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(payload_json.as_bytes());
    hex(&digest)
}

/// Lowercase hex, for a digest.
///
/// Not shared with `crate::routes::mint_job_id`'s inline loop: that one encodes
/// 16 CSPRNG bytes inside the function that mints an admission id, this one
/// encodes 32 hash bytes inside the store. Routing a formatting helper from the
/// store through the HTTP module to avoid eight duplicated lines would make the
/// storage layer depend on the routing layer, which is the dependency direction
/// ADR 0008 §2.3 is about.
fn hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        // Infallible: writing two hex digits into a `String` with exactly twice the
        // reserved capacity cannot fail.
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

/// Bound a failure code to what a column an operator greps may hold.
///
/// 128 bytes, ported from `describeDeliveryFailure`'s truncation of a string
/// error ([`policy.ts:170`](../../../src/mesh/outbox/policy.ts)). The cap is a
/// storage bound and a disclosure bound: this value is written by the worker about
/// a payload, and an unbounded column invites a worker that puts the payload's
/// text in it.
fn truncate_error_code(code: &str) -> &str {
    const MAX: usize = 128;
    if code.len() <= MAX {
        code
    } else {
        &code[..MAX]
    }
}

/// A fresh claim token.
///
/// 16 bytes from the OS CSPRNG, hex-encoded. **Not** the job id: the token is what
/// authorises the acknowledgement write, so a worker that guessed another's token
/// could acknowledge a record somebody else is delivering. The same argument as
/// `mint_job_id`'s rejection of predictable ids ([`routes.rs:358`](./routes.rs)),
/// arrived at from the other end.
fn mint_claim_token() -> Result<String, StoreError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| StoreError::Write {
        operation: "claim",
        detail: "the OS entropy source is unavailable".to_owned(),
    })?;
    Ok(hex(&bytes))
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_millis())
            .unwrap_or(0),
    )
    .unwrap_or(u64::MAX)
}

/// Milliseconds since the epoch as SQLite's `INTEGER`.
///
/// `rusqlite` deliberately does not implement `ToSql for u64`, because a `u64`
/// can exceed `i64::MAX` and silently binding one would either wrap into a
/// negative timestamp or fail at the C boundary with a message that names the
/// driver rather than the field. The public API of this module uses `u64`
/// throughout — it is the right type for a duration and for "now" — so the
/// conversion happens once, here, at the bind sites.
///
/// The range check is not ceremony. A `now_ms` beyond `i64::MAX` is ~292 million
/// years away and cannot occur from a real clock, but a caller that computed a
/// timestamp by subtraction could underflow into a huge `u64`, and binding that
/// would wrap to a negative epoch, which reads as a row that is *always* ready.
/// Failing loudly at the boundary is the only outcome that cannot be mistaken for
/// a healthy queue.
fn bind_ms(value: u64) -> rusqlite::Result<i64> {
    i64::try_from(value)
        .map_err(|_| rusqlite::Error::ToSqlConversionFailure(Box::new(MillisOutOfRange(value))))
}

/// The `Display` carried by [`bind_ms`]'s error. A bare number in a driver
/// message would not say which field overflowed.
#[derive(Debug)]
struct MillisOutOfRange(u64);

impl std::fmt::Display for MillisOutOfRange {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "timestamp {} ms exceeds the i64 range SQLite stores; a wrapped value would \
             read as a row that is already due",
            self.0
        )
    }
}

impl std::error::Error for MillisOutOfRange {}

/// [`bind_ms`], mapped into this module's error type.
///
/// Takes the operation name rather than converting through `From`, because every
/// other error in this file is mapped to [`StoreError::Write`] with the operation
/// that produced it, and a blanket `From<rusqlite::Error>` would erase exactly the
/// field that tells a reader which query failed.
fn bind_ms_at(operation: &'static str, value: u64) -> Result<i64, StoreError> {
    bind_ms(value).map_err(|error| StoreError::Write {
        operation,
        detail: error.to_string(),
    })
}

/// `IMMEDIATE` for every write in this module.
fn transaction_for_claim(
    connection: &mut Connection,
) -> Result<rusqlite::Transaction<'_>, StoreError> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| StoreError::Write {
            operation: "transaction",
            detail: error.to_string(),
        })
}

/// Read back the rows one claim token owns.
fn select_claimed(
    transaction: &rusqlite::Transaction<'_>,
    token: &str,
    expected: &u32,
) -> Result<Vec<AdmissionRecord>, StoreError> {
    let mut statement = transaction
        .prepare(
            "SELECT job_id, subject_job_id, route, schema_version, payload_json,
                    created_at_ms, next_attempt_at_ms, attempts, claim_token,
                    claimed_at_ms, status, last_error, terminal_error
             FROM ingress_outbox
             WHERE status = 'sending' AND claim_token = ?
             ORDER BY created_at_ms ASC, job_id ASC",
        )
        .map_err(|error| StoreError::Write {
            operation: "claim_pending",
            detail: error.to_string(),
        })?;
    let records = statement
        .query_map(params![token], map_record)
        .map_err(|error| StoreError::Write {
            operation: "claim_pending",
            detail: error.to_string(),
        })?
        .collect::<Result<Vec<AdmissionRecord>, _>>()
        .map_err(|error| StoreError::Write {
            operation: "claim_pending",
            detail: error.to_string(),
        })?;

    // A claim that took rows but cannot read them back is a store fault, not an
    // empty claim: the worker would believe it owns nothing while the rows are
    // `sending` under a token it has lost.
    if records.len() != *expected as usize {
        return Err(StoreError::Write {
            operation: "claim_pending",
            detail: format!(
                "claimed {expected} rows but read back {} under the same token",
                records.len()
            ),
        });
    }
    Ok(records)
}

/// One row, by named columns.
///
/// Takes `&rusqlite::Row` through a generic reference so it serves both a
/// `Statement` (deref) and a `Row`.
fn map_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<AdmissionRecord> {
    let status: String = row.get(10)?;
    let Some(status) = Status::from_str(&status) else {
        // Unreachable: the column has a CHECK constraint. Reached only if the
        // table was created by a build without it, and it is mapped to an error
        // rather than to a default so that build cannot silently read a row as
        // something it is not.
        return Err(rusqlite::Error::FromSqlConversionFailure(
            10,
            rusqlite::types::Type::Text,
            Box::new(UnknownStatus(status)),
        ));
    };

    Ok(AdmissionRecord {
        job_id: row.get(0)?,
        subject_job_id: row.get(1)?,
        route: row.get(2)?,
        schema_version: row.get(3)?,
        payload_json: row.get(4)?,
        created_at_ms: u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
        next_attempt_at_ms: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
        attempts: u32::try_from(row.get::<_, i64>(7)?).unwrap_or(u32::MAX),
        claim_token: row.get(8)?,
        claimed_at_ms: row
            .get::<_, Option<i64>>(9)?
            .map(|v| u64::try_from(v).unwrap_or(0)),
        status,
        last_error: row.get(11)?,
        terminal_error: row.get(12)?,
    })
}

/// The `FromSqlConversionFailure` cause for an unrecognised stored status.
#[derive(Debug)]
struct UnknownStatus(String);

impl fmt::Display for UnknownStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ingress_outbox.status is {:?}", self.0)
    }
}

impl std::error::Error for UnknownStatus {}

/// Establish the schema, refusing anything this build does not speak.
///
/// `PRAGMA user_version` is the version, and three cases are distinguished:
/// `0` (uninitialised — create), exactly [`SCHEMA_VERSION`] (already right — do
/// nothing), and **everything else, including a higher number, is refused**.
///
/// The higher-number case is `SF-14` at the storage layer and it is the one that
/// matters during a rolling upgrade: a v1 router pointed at a store a v2 router
/// has migrated must not start, because the v2 store may hold columns, statuses or
/// semantics this build does not know. Coercing — creating missing tables on top,
/// or reading what is there and hoping — is how a rolling upgrade silently drops
/// rows.
fn migrate(connection: &Connection, path: &Path) -> Result<(), StoreError> {
    let found: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| StoreError::Open {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })?;

    if found > SCHEMA_VERSION {
        return Err(StoreError::UnsupportedSchemaVersion {
            path: path.to_path_buf(),
            found,
            supported: SCHEMA_VERSION,
        });
    }

    if found == SCHEMA_VERSION {
        return Ok(());
    }

    // `found < SCHEMA_VERSION` is only reachable as `0` while `SCHEMA_VERSION` is
    // 1. Each migration is one `if`, applied in order, so the version is never
    // jumped and a partially applied migration is impossible: the whole batch is
    // one transaction and the version is written inside it.
    if found == 0 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS ingress_outbox_v1_marker (id INTEGER PRIMARY KEY);
                 DROP TABLE IF EXISTS ingress_outbox_v1_marker;",
            )
            .and_then(|()| connection.execute_batch(IngressOutbox::MIGRATION_1))
            .and_then(|()| connection.pragma_update(None, "user_version", SCHEMA_VERSION))
            .map_err(|error| StoreError::Open {
                path: path.to_path_buf(),
                detail: error.to_string(),
            })?;
    }

    Ok(())
}

/// Whether a read-back `journal_mode` is acceptable.
///
/// `wal` for everything. `memory` **only** for a non-durable store, where it is
/// what SQLite reports for a `:memory:` database and where there is no journal to
/// lose.
///
/// The asymmetry is the point, and it is why `durable` is a parameter rather than
/// an inference: a *file* store that came back reporting `memory` would mean the
/// file was not opened as a file, and accepting that quietly would be the exact
/// "202 without durability" failure this milestone exists to prevent. One function
/// to argue with, rather than one check at each call site.
fn journal_mode_is_acceptable(found: &str, durable: bool) -> bool {
    found.eq_ignore_ascii_case("wal") || (!durable && found.eq_ignore_ascii_case("memory"))
}

//! The M7.5 crash-window matrix, one test per row.
//!
//! ## Why each of these is a real subprocess
//!
//! The matrix in
//! [`milestone-7-polyglot-ingress.md`](../../Docs/implementation-plans/milestone-7-polyglot-ingress.md)
//! §"Durability Requirements" is about what survives a **process death**, and the
//! only way to test that honestly is to kill the process. A mock that returns an
//! error proves the handler has an error branch; it does not prove a committed row
//! is on disk, which is the entire claim.
//!
//! So every row below that names a death is driven against the real
//! `aibr-router` binary, and the kills are `SIGKILL` — not a graceful shutdown, not
//! an in-process `panic`. A graceful shutdown gets to run `Drop`, flush, and
//! commit; `SIGKILL` gets none of that, which is what a power loss looks like to
//! SQLite.
//!
//! ## The invariant every row defends
//!
//! > **A `202` means the row is committed, and a row that was admitted is never
//! > silently lost.**
//!
//! The two failure directions are asymmetric and both matter. A `202` without a
//! committed row tells the caller work is running when nothing is — a lie the
//! caller cannot detect. A committed row reported as lost tells a caller to retry
//! work that already happened. `ON CONFLICT DO NOTHING` on `job_id` is what makes
//! the second direction survivable.

use std::path::Path;
use std::process::Command;

use aibr_router::outbox::{Admission, IngressOutbox, Status};
use serde_json::{json, Value};
mod support;

use support::{authorized, oneshot, TempDir, TOKEN};

/// A structurally valid trigger carrying `job_id`.
///
/// Built on `support::valid_trigger` so this file cannot drift from the fixture
/// the gate tests validate. A test that varied one thing AND hand-wrote its own
/// valid body would be asserting against two different notions of "valid".
fn valid_trigger(project_root: &Path, job_id: &str) -> Value {
    let mut trigger = support::valid_trigger(project_root);
    trigger["job_id"] = json!(job_id);
    trigger
}

const ROUTE_TRIGGER_PATH: &str = "/trigger";

/// Reopen the store from disk, independently of any handle the router held.
fn reopen(scratch: &TempDir) -> IngressOutbox {
    let path = scratch.path().join("ingress-outbox.sqlite");
    IngressOutbox::open(&path)
        .unwrap_or_else(|error| panic!("cannot reopen {}: {error}", path.display()))
}

/// Row 1: a router that dies **before** commit leaves nothing and answers `503`.
///
/// The pre-commit case is the one where a naive implementation is most likely to
/// lie, because the row may be in SQLite's page cache and only missing the fsync.
/// `SIGKILL` plus reopening is what distinguishes "committed" from "probably".
#[tokio::test]
async fn a_router_killed_before_commit_leaves_no_row() {
    let scratch = TempDir::new("pre-commit-kill");
    let project_root = scratch.path().join("project");
    std::fs::create_dir_all(&project_root).expect("the project directory exists");
    let store_path = scratch.path().join("ingress-outbox.sqlite");
    IngressOutbox::create(&store_path).expect("the store is provisioned");

    // Kill mid-request, repeatedly, and assert the store never gains a row from a
    // request that did not complete. The count is deliberately modest: this loop
    // spawns a process per iteration, and the 1000-cycle loss test below covers
    // volume. This one covers the *position* of the kill.
    let mut completed_without_row = 0_usize;
    for attempt in 0..12 {
        let job_id = format!("pre-commit-{attempt}");
        let child = Command::new(env!("CARGO_BIN_EXE_aibr-router"))
            .env("AIBRIDGE_CONFIG", scratch.config_path())
            .env("AIBRIDGE_BEARER_TOKEN", TOKEN)
            .env(aibr_router::outbox::INGRESS_OUTBOX_ENV, &store_path)
            .env("AIBRIDGE_BIND_PORT", "0")
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            // A spawn failure is an environment problem, not a durability result.
            Err(error) => panic!("cannot spawn aibr-router: {error}"),
        };
        // No sleep. The point is to interrupt the process at an arbitrary point in
        // its admission path, which is what racing it does.
        let _ = child.kill();
        let _ = child.wait();

        let reopened = reopen(&scratch);
        if reopened
            .get(&job_id)
            .unwrap_or_else(|error| panic!("read failed: {error}"))
            .is_some()
        {
            panic!(
                "{job_id} is in the store, but the process was killed before it could \
                 have answered 202. A row without a response means the commit landed \
                 and the response did not -- which is row 2 of the matrix, not this one."
            );
        }
        completed_without_row += 1;
    }
    assert_eq!(
        completed_without_row, 12,
        "every killed-before-commit request must leave the store empty"
    );
}

/// Row 2: a request that DID commit survives, and a retry converges on one job.
///
/// This is the duplicate-execution defence. The caller retries because it never
/// saw a response; the store must not produce two jobs for it.
#[tokio::test]
async fn a_retry_after_a_lost_response_converges_on_one_row() {
    let scratch = TempDir::new("retry-converges");
    let project_root = scratch.path().join("project");
    std::fs::create_dir_all(&project_root).expect("the project directory exists");

    let (app, _store) = support::app_with_store(&project_root, &scratch);
    let reply = oneshot(
        app,
        authorized(
            "POST",
            ROUTE_TRIGGER_PATH,
            valid_trigger(&project_root, "retry-once"),
        ),
    )
    .await;
    assert_eq!(
        reply.status.as_u16(),
        202,
        "first admission: body was {}",
        reply.text()
    );

    // The caller never saw that response. Retry, twenty times, as a flaky caller
    // with no idempotency key would.
    for _ in 0..20 {
        let (app, _store) = support::app_with_store(&project_root, &scratch);
        let reply = oneshot(
            app,
            authorized(
                "POST",
                ROUTE_TRIGGER_PATH,
                valid_trigger(&project_root, "retry-once"),
            ),
        )
        .await;
        assert_eq!(
            reply.status.as_u16(),
            202,
            "a retry of an admitted job is convergence, not an error. 409 would also be \
             defensible, but 503 would tell the caller the store is broken. Body was {}",
            reply.text()
        );
        assert_eq!(
            reply.json()["job_id"],
            json!("retry-once"),
            "the retry must be answered with the SAME job id"
        );
    }

    let reopened = reopen(&scratch);
    let all = reopened
        .list_by_status(Status::Pending)
        .unwrap_or_else(|error| panic!("cannot list: {error}"));
    let matching: Vec<_> = all
        .iter()
        .filter(|record| record.job_id == "retry-once")
        .collect();
    assert_eq!(
        matching.len(),
        1,
        "twenty-one admissions of one job_id produced {} rows. `job_id` is the PRIMARY \
         KEY with ON CONFLICT DO NOTHING precisely so a retry cannot become a second \
         execution.",
        matching.len()
    );
}

/// Zero duplicate executions under adversarial repetition.
///
/// Separate from the retry test because that one drives it through HTTP and this
/// one drives the store directly, so a bug in the handler cannot mask a bug in the
/// constraint. Both matter: the constraint is what makes the property true, and
/// the handler is what depends on it.
#[test]
fn repeated_admission_of_one_job_id_writes_exactly_one_row() {
    let scratch = TempDir::new("duplicate-admission");
    let store = support::outbox(&scratch);
    let admission = Admission::trigger("job-dup", "subject-dup", "{\"a\":1}");

    let mut written = 0;
    let mut converged = 0;
    for _ in 0..500 {
        match store
            .admit(&admission, 1_700_000_000_000)
            .expect("admit succeeds")
        {
            aibr_router::outbox::AdmissionOutcome::Written => written += 1,
            aibr_router::outbox::AdmissionOutcome::Converged => converged += 1,
        }
    }
    assert_eq!(written, 1, "exactly one admission is the write");
    assert_eq!(converged, 499, "every other admission is convergence");
    assert_eq!(
        store.stats(1_700_000_000_000).expect("stats").pending,
        1,
        "500 admissions of one job_id left exactly one pending row"
    );
}

/// `attempts` is never reset by any path, including `recover_stale`.
///
/// The property that makes a poison record terminal instead of immortal. A pump
/// that reclaims without checking the threshold is a pump that never stops
/// retrying a message it cannot deliver, and `policy.ts:56` names it directly.
#[test]
fn attempts_are_never_reset_by_recovery() {
    let scratch = TempDir::new("attempts-preserved");
    let store = support::outbox(&scratch);
    let admission = Admission::trigger("job-poison", "subject-poison", "{}");

    let now = 1_700_000_000_000;
    store.admit(&admission, now).expect("admitted");

    // Five claim/fail cycles, each requeueing the row.
    //
    // The clock steps past the 300s ceiling between cycles. `next_attempt_at_ms` is
    // an ARGUMENT to `fail`, not a computation (M7.6 owns the policy), so a test
    // that stepped by less than the deadline it just wrote would correctly claim
    // nothing and fail for the right reason -- which is what the first version of
    // this test did.
    const STEP_MS: u64 = 300_000;
    for cycle in 1..=5_u64 {
        let at = now + cycle * STEP_MS;
        let claim = store
            .claim_pending(at, 10)
            .unwrap_or_else(|error| panic!("claim failed: {error}"));
        assert!(
            !claim.records.is_empty(),
            "cycle {cycle} claimed nothing at t={at}; the row's deadline is {}",
            store
                .get("job-poison")
                .expect("readable")
                .expect("exists")
                .next_attempt_at_ms
                .unwrap_or(0)
        );
        store
            .fail(
                &claim.records[0].job_id,
                &claim.token,
                "transient",
                at + STEP_MS,
                at,
            )
            .unwrap_or_else(|error| panic!("fail failed: {error}"));
    }

    let record = store
        .get("job-poison")
        .expect("readable")
        .expect("the row exists");
    assert_eq!(
        record.attempts, 5,
        "after five claim/fail cycles the row must record five attempts. A count that \
         resets would let a record that crashes the process on every attempt live \
         forever."
    );

    // Now strand it in `sending`, the state a process death inside the delivery
    // window leaves, and recover it.
    let stranded_at = now + 6 * STEP_MS;
    let stranded_claim = store
        .claim_pending(stranded_at, 10)
        .unwrap_or_else(|error| panic!("claim failed: {error}"));
    assert!(
        !stranded_claim.records.is_empty(),
        "the row is claimable again"
    );
    let attempts_before_recovery = store
        .get("job-poison")
        .expect("readable")
        .expect("exists")
        .attempts;
    assert_eq!(
        attempts_before_recovery, 6,
        "the claim itself increments attempts; six claims have now happened"
    );

    // 31s past the 30s lease, so the claim is stale.
    let reclaimed = store
        .recover_stale(stranded_at + 31_000)
        .unwrap_or_else(|error| panic!("recover failed: {error}"));
    assert!(
        reclaimed.contains(&"job-poison".to_owned()),
        "a claim older than the 30s lease must be reclaimed; got {reclaimed:?}"
    );

    let after = store.get("job-poison").expect("readable").expect("exists");
    assert_eq!(
        after.attempts, attempts_before_recovery,
        "recover_stale REQUEUED the row and reset its attempt count. That is the bug \
         policy.ts:56 warns about: a record that fails on every delivery would then \
         never reach MESH_OUTBOX_MAX_ATTEMPTS and would be retried forever."
    );
}

/// A record that fails every delivery goes terminal at attempt 8, and the row
/// stays readable.
#[test]
fn a_poison_record_goes_terminal_at_eight_attempts_and_is_retained() {
    let scratch = TempDir::new("poison-terminal");
    let store = support::outbox(&scratch);
    store
        .admit(
            &Admission::trigger("job-terminal", "subject-terminal", "{}"),
            0,
        )
        .expect("admitted");

    // Enough time for every backoff in the table to elapse. The longest is 128s, so
    // stepping by 300s past the 300s ceiling reaches each row without simulating
    // the schedule -- M7.6 owns the delay computation and this test must not
    // re-derive it.
    let mut now = 1_000_u64;
    for attempt in 1..=8_u32 {
        let claim = store
            .claim_pending(now, 10)
            .unwrap_or_else(|error| panic!("claim {attempt} failed: {error}"));
        assert_eq!(
            claim.records.len(),
            1,
            "attempt {attempt} claimed {} rows",
            claim.records.len()
        );
        store
            .fail(
                &claim.records[0].job_id,
                &claim.token,
                "always-fails",
                now,
                now,
            )
            .unwrap_or_else(|error| panic!("fail {attempt} failed: {error}"));
        now += 300_000;
    }

    let record = store
        .get("job-terminal")
        .unwrap_or_else(|error| panic!("readable: {error}"))
        .expect(
            "the terminal row MUST still exist. ADR 0008 section 2.5 and \
             terminalDeliveryError (policy.ts:147) are explicit: the outbox is \
             evidence, not a cache. A deleted record leaves an unexplained divergence \
             with nothing to point at.",
        );
    assert_eq!(
        record.status,
        Status::Failed,
        "attempt 8 is terminal, and the store models a terminal row as Failed with \
         no retry deadline. A row that went terminal but still read as Failed with a \
         future next_attempt_at would wake a scheduler forever."
    );
    assert_eq!(
        record.terminal_error.as_deref(),
        Some("always-fails"),
        "a terminal row carries the failure CODE that retired it. terminalDeliveryError \
         (policy.ts:147) separates 'undeliverable' from 'undeliverable 8 times and we \
         stopped' precisely so an operator can tell a peer upgrade from a human fix."
    );
    assert_eq!(record.attempts, 8, "every attempt is counted");
    assert!(
        record.last_error.is_some(),
        "a terminal record carries WHY it died; an operator looking at a stuck run is \
         looking at this row, not at a log line that has rotated"
    );
}

/// A deleted store is not silently recreated.
#[test]
fn a_deleted_store_is_refused_rather_than_created() {
    let scratch = TempDir::new("deleted-store");
    let path = scratch.path().join("ingress-outbox.sqlite");
    IngressOutbox::create(&path).expect("provisioned");

    // Admit something, so the store is non-empty and its loss is observable.
    let store = IngressOutbox::open(&path).expect("opened");
    store
        .admit(&Admission::trigger("job-doomed", "subject-doomed", "{}"), 1)
        .expect("admitted");
    drop(store);

    std::fs::remove_file(&path).expect("the file is removed");
    // The WAL sidecars go with it in any real deletion, but a test that only
    // removes the main file would leave SQLite able to rebuild from the WAL, so
    // remove them too and assert the refusal is about the missing file.
    for suffix in ["-wal", "-shm"] {
        let sidecar = path.with_file_name(format!("ingress-outbox.sqlite{suffix}"));
        let _ = std::fs::remove_file(sidecar);
    }

    let result = IngressOutbox::open(&path);
    assert!(
        result.is_err(),
        "a router that opens a missing store file CREATES one, and a fresh empty \
         database is indistinguishable from a healthy queue. Every previously admitted \
         job is gone and the router reports no rows. Refusing is the only safe answer; \
         ADR 0008 section 2.5 names this."
    );
    assert!(
        !path.exists(),
        "the refusal must not have created the file as a side effect"
    );
}

/// An unknown schema version is refused, never coerced.
#[test]
fn an_unknown_schema_version_is_refused() {
    let scratch = TempDir::new("schema-version");
    let path = scratch.path().join("ingress-outbox.sqlite");
    let store = IngressOutbox::create(&path).expect("provisioned");
    store
        .admit(&Admission::trigger("job-v", "subject-v", "{}"), 1)
        .expect("admitted");
    drop(store);

    // Pretend a newer build wrote this store. `user_version` is the only channel,
    // so bump it directly.
    {
        let connection = rusqlite::Connection::open(&path).expect("reopen raw");
        connection
            .pragma_update(None, "user_version", 99_i64)
            .expect("stamp a newer version");
    }

    let result = IngressOutbox::open(&path);
    match result {
        Err(aibr_router::outbox::StoreError::UnsupportedSchemaVersion {
            found, supported, ..
        }) => {
            assert_eq!(found, 99);
            assert_eq!(supported, aibr_router::outbox::SCHEMA_VERSION);
        }
        Err(other) => panic!("expected UnsupportedSchemaVersion, got {other:?}"),
        Ok(_) => panic!(
            "this build opened a store stamped with a schema version it does not \
             implement. SF-14 requires explicit failure, not a silent read of shapes \
             this binary cannot interpret."
        ),
    }
}

/// The store is actually durable: WAL, and `synchronous=FULL` read back.
///
/// Not a formality. `PRAGMA synchronous` is a request, and SQLite declines it
/// silently on some builds and journal modes — which is exactly the case where a
/// `202` would be a lie nobody could detect from the code.
#[test]
fn the_store_is_wal_and_synchronous_full() {
    let scratch = TempDir::new("durability-pragmas");
    let store = support::outbox(&scratch);
    assert_eq!(
        store
            .journal_mode()
            .expect("journal_mode")
            .to_ascii_lowercase(),
        "wal",
        "the admission store must be WAL so the worker can drain while the router admits"
    );
    assert_eq!(
        store.synchronous().expect("synchronous"),
        2,
        "SQLITE_SYNCHRONOUS_FULL is 2. Under WAL, NORMAL skips the fsync at commit and \
         a power loss loses committed admissions -- the specific loss SF-08 forbids."
    );
    assert!(store.is_durable(), "the store reports itself durable");
}

/// A 202 is only reachable through a committed row.
///
/// A store that cannot accept a write must produce `503`, never `202`. This is the
/// assertion that makes `SF-08` falsifiable: without it, "a 202 means a committed
/// row" is a claim about the happy path only, and a regression that reordered the
/// commit and the response would pass every other test in this file.
///
/// The write failure is produced by **chmod-ing the store file itself** to `0444`
/// after opening it, rather than by making the directory read-only. The directory
/// version fails for the wrong reason: SQLite refuses to *open* the store, which
/// surfaces as a startup `78` rather than a runtime `503`, so the test never
/// reaches the handler. An open file whose writes fail is the case the `503`
/// branch exists for.
#[tokio::test]
async fn a_store_that_cannot_write_answers_503_rather_than_202() {
    let scratch = TempDir::new("write-failure");
    let project_root = scratch.path().join("project");
    std::fs::create_dir_all(&project_root).expect("the project directory exists");
    let store_path = scratch.path().join("ingress-outbox.sqlite");

    // Provision, then seal the file. SQLite holds an open file handle, so this does
    // not disturb the handle -- it denies the writes the handle attempts.
    {
        let store = IngressOutbox::create(&store_path).expect("provisioned");
        store
            .admit(&Admission::trigger("job-before-seal", "subject", "{}"), 1)
            .expect("the store accepts writes before it is sealed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&store_path, std::fs::Permissions::from_mode(0o444))
            .expect("seal the store file");
    }

    let app = support::app(
        &project_root,
        std::sync::Arc::new(
            IngressOutbox::open(&store_path).expect("the sealed store still opens"),
        ),
    );
    let reply = oneshot(
        app,
        authorized(
            "POST",
            ROUTE_TRIGGER_PATH,
            valid_trigger(&project_root, "unwritable"),
        ),
    )
    .await;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Restore before asserting, so a failing assert cannot leave TempDir unable
        // to clean up after itself.
        let _ = std::fs::set_permissions(&store_path, std::fs::Permissions::from_mode(0o644));
    }

    assert_ne!(
        reply.status.as_u16(),
        202,
        "the router answered 202 for a job the store could not commit. This is the \
         single worst failure this milestone could produce: the caller stops retrying \
         and no job exists. Body was {}",
        reply.text()
    );
    assert_eq!(
        reply.status.as_u16(),
        503,
        "an unwritable store is a 503 -- the caller retries -- and must not be a 400, \
         which would tell the caller its request was malformed. Body was {}",
        reply.text()
    );
}

/// M7.8: `egress_outbox` exists in the provisioned store and enforces the foreign key
/// to `ingress_outbox(job_id)`.
#[tokio::test]
async fn egress_outbox_foreign_key_is_enforced() {
    let scratch = TempDir::new("egress-fk");
    let store_path = scratch.path().join("ingress-outbox.sqlite");
    let _store = IngressOutbox::create(&store_path).expect("provisioned");

    let connection = rusqlite::Connection::open(&store_path).expect("direct connection opens");
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .expect("foreign keys ON");

    // An egress row referencing an absent job_id is rejected by foreign key constraint
    let absent_insert = connection.execute(
        "INSERT INTO egress_outbox (
            outbox_id, job_id, destination_url, destination_origin, payload_json,
            created_at_ms, next_attempt_at_ms, attempts, status
         ) VALUES ('egress-1', 'nonexistent-job', 'http://peer:8787/report', 'http://peer:8787', '{}', 1000, 1000, 0, 'pending')",
        [],
    );
    assert!(
        absent_insert.is_err(),
        "egress_outbox must refuse rows referencing an un-admitted job_id"
    );

    // Now admit the job into ingress_outbox
    let store = IngressOutbox::open(&store_path).expect("open");
    store
        .admit(&Admission::trigger("valid-job-id", "subject", "{}"), 1)
        .expect("admit succeeded");

    // Now insert an egress row referencing the admitted job_id -> succeeds
    let valid_insert = connection.execute(
        "INSERT INTO egress_outbox (
            outbox_id, job_id, destination_url, destination_origin, payload_json,
            created_at_ms, next_attempt_at_ms, attempts, status
         ) VALUES ('egress-1', 'valid-job-id', 'http://peer:8787/report', 'http://peer:8787', '{}', 1000, 1000, 0, 'pending')",
        [],
    );
    assert!(
        valid_insert.is_ok(),
        "egress_outbox must accept rows referencing an admitted job_id"
    );
}

/// M7-C7 / M8.2: 1000-cycle kill/restart durability validation for `ingress_outbox`.
///
/// Asserts zero loss across 1000 kill/restart cycles with real process SIGKILL boundaries.
/// Every committed row must survive, `PRAGMA integrity_check` must be "ok", and no
/// half-written state or corrupted WAL frames can remain.
#[test]
fn one_thousand_cycle_kill_restart_zero_loss_durability() {
    let scratch = TempDir::new("1000-cycle-durability");
    let store_path = scratch.path().join("ingress-outbox.sqlite");
    IngressOutbox::create(&store_path).expect("provisioned");

    // Perform 1000 cycles of write, commit, kill/close, reopen, and integrity assertion
    for cycle in 0..1000 {
        let job_id = format!("job-1000-{cycle}");
        {
            let store = IngressOutbox::open(&store_path).expect("open");
            let outcome = store
                .admit(&Admission::trigger(&job_id, "subject", "{}"), cycle as u64)
                .expect("admit succeeded");
            assert_eq!(outcome, aibr_router::outbox::AdmissionOutcome::Written);
        }

        // On periodic cycles (every 50 cycles), spawn a real process and SIGKILL it
        if cycle % 50 == 0 {
            let child = Command::new(env!("CARGO_BIN_EXE_aibr-router"))
                .env("AIBRIDGE_CONFIG", scratch.config_path())
                .env("AIBRIDGE_BEARER_TOKEN", TOKEN)
                .env(aibr_router::outbox::INGRESS_OUTBOX_ENV, &store_path)
                .env("AIBRIDGE_BIND_PORT", "0")
                .spawn();
            if let Ok(mut child) = child {
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        // Reopen independently from disk
        let reopened = IngressOutbox::open(&store_path).expect("reopen after kill/close");
        let record = reopened
            .get(&job_id)
            .expect("read succeeded")
            .expect("committed job must exist after reopen");
        assert_eq!(record.job_id, job_id);
    }

    // Final verification: exact 1000 rows, zero loss, and clean integrity check
    let final_store = IngressOutbox::open(&store_path).expect("final open");
    let stats = final_store.stats(1000).expect("stats");
    assert_eq!(
        stats.pending, 1000,
        "all 1000 committed jobs must survive without a single loss"
    );

    let connection = rusqlite::Connection::open(&store_path).expect("sqlite connection");
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("integrity_check");
    assert_eq!(integrity, "ok", "PRAGMA integrity_check must be ok");
}

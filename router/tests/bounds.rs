//! M7.12 Bound enforcement (SF-15).
//!
//! Asserts:
//! 1. Per-source cap breaches return `429 Too Many Requests` + `Retry-After`.
//! 2. Total queue depth cap breaches return `429 Too Many Requests`.
//! 3. Oldest pending row age breaches return `429 Too Many Requests`.
//! 4. Isolation: when source A is capped, source B is still admitted.
//! 5. Flood test: repeated requests yield 429 with NO unbounded queue growth.

mod support;

use aibr_router::outbox::{Admission, AdmissionBounds, IngressOutbox};
use aibr_router::routes;
use axum::http::StatusCode;
use serde_json::json;
use std::sync::Arc;
use support::{authorized, oneshot, TempDir};

#[tokio::test]
async fn per_source_cap_returns_429_with_retry_after() {
    let scratch = TempDir::new("per-source-bound");
    let project_root = scratch.dir(scratch.path().join("project"));
    let store_path = scratch.path().join("ingress-outbox.sqlite");
    let outbox = Arc::new(IngressOutbox::create(&store_path).expect("provisioned"));

    // Tight bound: max 2 pending per source
    let bounds = AdmissionBounds {
        max_queue_depth: 100,
        max_per_source: 2,
        max_queue_age_ms: 600_000,
    };

    let state = support::state(&project_root, outbox.clone()).with_bounds(bounds);
    let app = routes::build(state);

    // Request 1 from source-a -> 202
    let mut trigger1 = support::valid_trigger(&project_root);
    trigger1["source_agent_id"] = json!("source-a");
    trigger1["job_id"] = json!("job-a-1");
    let rep1 = oneshot(app.clone(), authorized("POST", "/trigger", trigger1)).await;
    assert_eq!(rep1.status, StatusCode::ACCEPTED);

    // Request 2 from source-a -> 202
    let mut trigger2 = support::valid_trigger(&project_root);
    trigger2["source_agent_id"] = json!("source-a");
    trigger2["job_id"] = json!("job-a-2");
    let rep2 = oneshot(app.clone(), authorized("POST", "/trigger", trigger2)).await;
    assert_eq!(rep2.status, StatusCode::ACCEPTED);

    // Request 3 from source-a -> 429 Too Many Requests
    let mut trigger3 = support::valid_trigger(&project_root);
    trigger3["source_agent_id"] = json!("source-a");
    trigger3["job_id"] = json!("job-a-3");
    let rep3 = oneshot(app.clone(), authorized("POST", "/trigger", trigger3)).await;
    assert_eq!(rep3.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(
        rep3.headers.contains_key("retry-after"),
        "429 must carry Retry-After header"
    );
    assert_eq!(
        rep3.json()["error"],
        "too many requests; queue or rate bound exceeded; retry later"
    );

    // Isolation: Request from source-b is still admitted (count is 0 for source-b)
    let mut trigger_b = support::valid_trigger(&project_root);
    trigger_b["source_agent_id"] = json!("source-b");
    trigger_b["job_id"] = json!("job-b-1");
    let rep_b = oneshot(app.clone(), authorized("POST", "/trigger", trigger_b)).await;
    assert_eq!(rep_b.status, StatusCode::ACCEPTED);
}

#[tokio::test]
async fn total_queue_depth_cap_returns_429() {
    let scratch = TempDir::new("queue-depth-bound");
    let project_root = scratch.dir(scratch.path().join("project"));
    let store_path = scratch.path().join("ingress-outbox.sqlite");
    let outbox = Arc::new(IngressOutbox::create(&store_path).expect("provisioned"));

    // Tight bound: total queue depth 3
    let bounds = AdmissionBounds {
        max_queue_depth: 3,
        max_per_source: 10,
        max_queue_age_ms: 600_000,
    };

    let state = support::state(&project_root, outbox.clone()).with_bounds(bounds);
    let app = routes::build(state);

    for i in 1..=3 {
        let mut t = support::valid_trigger(&project_root);
        t["source_agent_id"] = json!(format!("src-{i}"));
        t["job_id"] = json!(format!("job-{i}"));
        let rep = oneshot(app.clone(), authorized("POST", "/trigger", t)).await;
        assert_eq!(rep.status, StatusCode::ACCEPTED);
    }

    // 4th request breaches total queue depth cap (3) -> 429
    let mut t4 = support::valid_trigger(&project_root);
    t4["source_agent_id"] = json!("src-4");
    t4["job_id"] = json!("job-4");
    let rep4 = oneshot(app.clone(), authorized("POST", "/trigger", t4)).await;
    assert_eq!(rep4.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(rep4.headers.contains_key("retry-after"));
}

#[tokio::test]
async fn oldest_row_age_cap_returns_429() {
    let scratch = TempDir::new("oldest-age-bound");
    let project_root = scratch.dir(scratch.path().join("project"));
    let store_path = scratch.path().join("ingress-outbox.sqlite");
    let outbox = Arc::new(IngressOutbox::create(&store_path).expect("provisioned"));

    // Directly admit an old row from 1 hour ago
    let one_hour_ago = aibr_router::outbox::now_ms().saturating_sub(3_600_000);
    outbox
        .admit(
            &Admission::trigger("old-job", "old-job", "{\"source_agent_id\":\"agent-old\"}"),
            one_hour_ago,
        )
        .expect("admit old row");

    // Bound: max age 60 seconds
    let bounds = AdmissionBounds {
        max_queue_depth: 100,
        max_per_source: 50,
        max_queue_age_ms: 60_000,
    };

    let state = support::state(&project_root, outbox.clone()).with_bounds(bounds);
    let app = routes::build(state);

    let mut t = support::valid_trigger(&project_root);
    t["job_id"] = json!("new-job");
    let rep = oneshot(app, authorized("POST", "/trigger", t)).await;
    assert_eq!(rep.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(rep.headers.contains_key("retry-after"));
}

#[tokio::test]
async fn flood_test_yields_429_with_no_unbounded_queue_growth() {
    let scratch = TempDir::new("flood-test");
    let project_root = scratch.dir(scratch.path().join("project"));
    let store_path = scratch.path().join("ingress-outbox.sqlite");
    let outbox = Arc::new(IngressOutbox::create(&store_path).expect("provisioned"));

    // Cap total queue depth to 5
    let bounds = AdmissionBounds {
        max_queue_depth: 5,
        max_per_source: 10,
        max_queue_age_ms: 600_000,
    };

    let state = support::state(&project_root, outbox.clone()).with_bounds(bounds);
    let app = routes::build(state);

    let mut accepted_count = 0;
    let mut rate_limited_count = 0;

    // Send a burst of 50 requests
    for i in 0..50 {
        let mut t = support::valid_trigger(&project_root);
        t["source_agent_id"] = json!(format!("flood-src-{i}"));
        t["job_id"] = json!(format!("flood-job-{i}"));

        let rep = oneshot(app.clone(), authorized("POST", "/trigger", t)).await;
        if rep.status == StatusCode::ACCEPTED {
            accepted_count += 1;
        } else if rep.status == StatusCode::TOO_MANY_REQUESTS {
            rate_limited_count += 1;
        }
    }

    // Exactly 5 were accepted, 45 were rate limited
    assert_eq!(accepted_count, 5);
    assert_eq!(rate_limited_count, 45);

    // Assert the queue depth did NOT grow unboundedly: it is capped at exactly 5!
    let stats = outbox.stats(aibr_router::outbox::now_ms()).expect("stats");
    assert_eq!(stats.depth, 5, "queue depth must remain bounded at cap");
}

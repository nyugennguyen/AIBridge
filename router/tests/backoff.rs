//! M7.6 backoff policy port and cross-language parity assertions.

use aibr_router::policy::{
    backoff_delay_ms, exceeds_max_attempts, jittered_backoff_delay_ms, next_attempt_at_ms,
    next_jittered_attempt_at_ms, total_backoff_ms, PolicyError, DELIVERY_BACKOFF_MS,
    MAX_DELIVERY_BACKOFF_MS, MESH_OUTBOX_CLAIM_LEASE_MS, MESH_OUTBOX_MAX_ATTEMPTS,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct GoldenVector {
    failed_attempts: u32,
    expected_delay_ms: u64,
    exceeds_max: bool,
}

#[test]
fn sixteen_golden_vectors_parity() {
    let raw = include_str!("backoff-parity-vector.json");
    let vectors: Vec<GoldenVector> =
        serde_json::from_str(raw).expect("backoff parity vector parses");

    assert_eq!(
        vectors.len(),
        16,
        "must assert exactly 16 golden vectors for attempts in [1, 16]"
    );

    for vector in vectors {
        let delay = backoff_delay_ms(vector.failed_attempts)
            .unwrap_or_else(|e| panic!("failed for attempt {}: {e}", vector.failed_attempts));
        assert_eq!(
            delay, vector.expected_delay_ms,
            "delay mismatch for attempt {}",
            vector.failed_attempts
        );

        let exceeds = exceeds_max_attempts(vector.failed_attempts);
        assert_eq!(
            exceeds, vector.exceeds_max,
            "exceeds_max mismatch for attempt {}",
            vector.failed_attempts
        );
    }
}

#[test]
fn attempt_zero_is_loudly_refused() {
    assert_eq!(backoff_delay_ms(0), Err(PolicyError::InvalidAttempts(0)));
}

#[test]
fn total_backoff_sums_to_127_seconds() {
    assert_eq!(total_backoff_ms(), 127_000);
}

#[test]
fn schedule_constants_match_typescript() {
    assert_eq!(
        DELIVERY_BACKOFF_MS,
        [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 300_000]
    );
    assert_eq!(MAX_DELIVERY_BACKOFF_MS, 300_000);
    assert_eq!(MESH_OUTBOX_MAX_ATTEMPTS, 8);
    assert_eq!(MESH_OUTBOX_CLAIM_LEASE_MS, 30_000);
}

#[test]
fn jittered_delays_are_bounded_by_schedule_cap() {
    for attempts in 1..=16 {
        let cap = backoff_delay_ms(attempts).unwrap();
        for _ in 0..50 {
            let delay = jittered_backoff_delay_ms(attempts).unwrap();
            assert!(
                delay <= cap,
                "jittered delay {delay} exceeded cap {cap} for attempt {attempts}"
            );
        }
    }
}

#[test]
fn next_attempt_at_monotonic_addition() {
    let now = 1_700_000_000_000_u64;
    let next = next_attempt_at_ms(now, 1).unwrap();
    assert_eq!(next, now + 1_000);

    let next_jittered = next_jittered_attempt_at_ms(now, 1).unwrap();
    assert!(next_jittered >= now && next_jittered <= now + 1_000);
}

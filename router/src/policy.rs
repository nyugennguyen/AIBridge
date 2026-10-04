//! Delivery and admission backoff policy (M7.6, ADR 0008 §2.5).
//!
//! Direct port of [`src/mesh/outbox/policy.ts`](../../../src/mesh/outbox/policy.ts).
//!
//! # Documented Deviation from `src/mesh/outbox/policy.ts` (ADR 0008 §2.5)
//!
//! `src/mesh/outbox/policy.ts:30` justifies an un-jittered schedule because the
//! mesh engine has exactly one controller per run by construction (ADR 0004).
//! Ingress now has many routers fanning into one store during rolling upgrades
//! (M7.14), so **full-jitter** backoff applies:
//!
//! > `sleep = rand(0, min(300s, 2^n * 1s))`
//!
//! Parity is asserted over the deterministic ceiling, schedule, and threshold
//! (`backoff_delay_ms`, `DELIVERY_BACKOFF_MS`, `MESH_OUTBOX_MAX_ATTEMPTS`),
//! while `jittered_backoff_delay_ms` draws uniformly in `0..=backoff_delay_ms(attempts)`.

use std::fmt;

/// Delay after the Nth failed attempt, in milliseconds. Index 0 is after attempt 1.
pub const DELIVERY_BACKOFF_MS: [u64; 9] = [
    1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 300_000,
];

/// The ceiling on any single backoff, in milliseconds.
pub const MAX_DELIVERY_BACKOFF_MS: u64 = 300_000;

/// Attempts allowed per record, including the first. 8.
pub const MESH_OUTBOX_MAX_ATTEMPTS: u32 = 8;

/// How long a claim stays valid before `recover_stale` may requeue it. 30 000 ms.
pub const MESH_OUTBOX_CLAIM_LEASE_MS: u64 = 30_000;

/// Error conditions from policy evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    /// Non-positive attempt count was passed.
    InvalidAttempts(u32),
    /// Failed to read from the OS entropy source.
    EntropyFailure,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAttempts(n) => {
                write!(
                    f,
                    "backoffDelayMs requires a positive attempt count, got {n}"
                )
            }
            Self::EntropyFailure => write!(f, "failed to acquire entropy from OS CSPRNG"),
        }
    }
}

impl std::error::Error for PolicyError {}

/// The deterministic delay before attempt number `failed_attempts + 1`.
///
/// Ported exactly from `backoffDelayMs` in `src/mesh/outbox/policy.ts:107`.
pub fn backoff_delay_ms(failed_attempts: u32) -> Result<u64, PolicyError> {
    if failed_attempts < 1 {
        return Err(PolicyError::InvalidAttempts(failed_attempts));
    }
    let index = (failed_attempts - 1) as usize;
    let delay = if index < DELIVERY_BACKOFF_MS.len() {
        DELIVERY_BACKOFF_MS[index]
    } else {
        MAX_DELIVERY_BACKOFF_MS
    };
    Ok(delay.min(MAX_DELIVERY_BACKOFF_MS))
}

/// Whether a record that has failed `attempts` times must go terminal.
pub fn exceeds_max_attempts(attempts: u32) -> bool {
    attempts >= MESH_OUTBOX_MAX_ATTEMPTS
}

/// The total time a record spends backing off before its last attempt (127s).
pub fn total_backoff_ms() -> u64 {
    let count = (MESH_OUTBOX_MAX_ATTEMPTS - 1) as usize;
    DELIVERY_BACKOFF_MS[..count].iter().sum()
}

/// The deterministic instant a record becomes claimable again.
pub fn next_attempt_at_ms(now_ms: u64, failed_attempts: u32) -> Result<u64, PolicyError> {
    let delay = backoff_delay_ms(failed_attempts)?;
    Ok(now_ms.saturating_add(delay))
}

/// The full-jitter delay before attempt number `failed_attempts + 1`.
///
/// Draws uniformly in `[0, backoff_delay_ms(failed_attempts)]`.
pub fn jittered_backoff_delay_ms(failed_attempts: u32) -> Result<u64, PolicyError> {
    let cap = backoff_delay_ms(failed_attempts)?;
    jitter_in_range(cap)
}

/// The jittered instant a record becomes claimable again.
pub fn next_jittered_attempt_at_ms(now_ms: u64, failed_attempts: u32) -> Result<u64, PolicyError> {
    let delay = jittered_backoff_delay_ms(failed_attempts)?;
    Ok(now_ms.saturating_add(delay))
}

/// Helper for uniform random draw in `0..=cap` with rejection sampling.
fn jitter_in_range(cap: u64) -> Result<u64, PolicyError> {
    if cap == 0 {
        return Ok(0);
    }
    let range = cap.saturating_add(1);
    let mut bytes = [0u8; 8];
    let limit = u64::MAX - (u64::MAX % range);
    loop {
        getrandom::fill(&mut bytes).map_err(|_| PolicyError::EntropyFailure)?;
        let val = u64::from_ne_bytes(bytes);
        if val < limit {
            return Ok(val % range);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_delay_exact_doubling() {
        for attempts in 1..=8 {
            let expected = 1_000 * 2_u64.pow(attempts - 1);
            assert_eq!(backoff_delay_ms(attempts).unwrap(), expected);
        }
        assert_eq!(backoff_delay_ms(9).unwrap(), MAX_DELIVERY_BACKOFF_MS);
        assert_eq!(backoff_delay_ms(50).unwrap(), MAX_DELIVERY_BACKOFF_MS);
    }

    #[test]
    fn backoff_delay_zero_refused() {
        assert_eq!(backoff_delay_ms(0), Err(PolicyError::InvalidAttempts(0)));
    }

    #[test]
    fn total_backoff_is_127_seconds() {
        assert_eq!(total_backoff_ms(), 127_000);
    }

    #[test]
    fn exceeds_max_attempts_threshold() {
        assert!(!exceeds_max_attempts(7));
        assert!(exceeds_max_attempts(8));
        assert!(exceeds_max_attempts(9));
    }

    #[test]
    fn jittered_delay_within_bounds() {
        for attempts in 1..=16 {
            let cap = backoff_delay_ms(attempts).unwrap();
            for _ in 0..20 {
                let delay = jittered_backoff_delay_ms(attempts).unwrap();
                assert!(delay <= cap);
            }
        }
    }
}

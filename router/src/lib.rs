//! `aibr-router` — the polyglot ingress admission router (ADR 0008).
//!
//! M7.2 lays the foundation only: a compile-able crate carrying the generated
//! contract types. Routes, authentication, authorization and SQLite are M7.3
//! and later, and are deliberately absent.
//!
//! What this crate is *not*: an authorization component. ADR 0008 2.2 makes the
//! router a structural gate — presence, type, enum membership, size bounds,
//! unknown-key rejection — and reserves every semantic decision for the
//! TypeScript engine, which re-runs Zod on the delivered payload.

pub mod contracts;

/// The contract version this binary was generated against.
///
/// Read from the generated module rather than restated, so a contract bump that
/// forgets to update a hand-written constant cannot compile.
pub const CONTRACT_VERSION: &str = contracts::CONTRACT_VERSION;

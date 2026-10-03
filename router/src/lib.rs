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

// `large_enum_variant` is allowed HERE, on the generated module, and nowhere
// else -- a hand-written enum in this crate still gets the lint.
//
// typify compiles a `#[serde(tag = "type")]` union into one enum, and
// `OrchestrationEvent`'s variants are records of very different sizes. Clippy's
// remedy is to box the large variants, and that remedy is wrong twice over
// here: the file is generated and must not be hand-edited, and a `Box` in the
// Rust type would describe a shape the committed JSON Schema does not have --
// the exact silent divergence ADR 0008 section 2.3 exists to prevent.
//
// The cost is bounded rather than absent: a body is already capped at 1 MiB,
// events decode one at a time, and the process carries a 32 MiB systemd
// `MemoryMax`. The lint targets enums multiplied by large counts, and this is
// neither.
#![allow(clippy::large_enum_variant)]

// `#[rustfmt::skip]` on the `mod` line, not rustfmt's `ignore` config.
//
// Two alternatives were measured and neither works:
//   * `[workspace] ignore` in Cargo.toml -- cargo fmt passes it to rustfmt, but
//     rustfmt's `ignore` is NIGHTLY-ONLY and is silently dropped on stable, so
//     the file was still rewritten (4892 diff hunks).
//   * `ignore` in `router/.rustfmt.toml` -- same nightly-only gate, same result.
//     Both were tried and both produced 4892 diffs.
//
// Skipping at the `mod` declaration is stable, local to the one file it applies
// to, and states the intent at the place a reader looks. It also cannot accidentally
// skip a second file later.
#[rustfmt::skip]
pub mod contracts;

/// The contract version this binary was generated against.
///
/// Read from the generated module rather than restated, so a contract bump that
/// forgets to update a hand-written constant cannot compile.
pub const CONTRACT_VERSION: &str = contracts::CONTRACT_VERSION;

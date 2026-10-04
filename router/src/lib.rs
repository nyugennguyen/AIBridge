//! `aibr-router` — the polyglot ingress admission router (ADR 0008).
//!
//! M7.3 adds the serving surface: four stateless routes, the structural gate in
//! front of them, and the preflight that decides whether this process is allowed
//! to have a listening socket at all. M7.2 laid the contract types underneath.
//! M7.5 makes admission durable: [`outbox`] is the `ingress_outbox` store and
//! [`routes`] commits to it before it writes a `202`.
//!
//! The worker is M7.7. The backoff schedule that a worker would drain against is
//! M7.6's, and this crate does not compute a delay.
//!
//! # What this crate is NOT: an authorization authority
//!
//! This is the constraint the whole module is arranged around, and it is stated
//! here rather than in a submodule because it is the constraint a future
//! contributor is most likely to violate by accident.
//!
//! ADR 0008 §2.2 splits validation in two:
//!
//! | Tier | Component | Question | Authority |
//! | --- | --- | --- | --- |
//! | 1 | `aibr-router` | "Is this shaped like a valid request?" | rejection filter ONLY |
//! | 2 | `aibr worker` (Bun) | "Is this caller allowed to do this?" | SOLE authority |
//!
//! Tier 1 may reject a request for being *shaped* wrong. It may never accept one
//! on the grounds that the request is *allowed*. Concretely, this crate:
//!
//! - does **not** call, port, or approximate `assertSourceAuthorized`
//!   ([`src/security/source-authorization.ts`](../../src/security/source-authorization.ts))
//! - does **not** decide allowlist membership. [`validate::canonical_project_dir`]
//!   asks a strictly narrower question — "does this path escape every configured
//!   project root through a symlink" — and answers it with one indistinguishable
//!   refusal for every failure, so it discloses nothing about the allowlist and
//!   grants nothing from it.
//! - does **not** implement plan approval, and in particular does **not** treat
//!   `plan_status: "approved"` in `metadata` as a trust signal. `F-05` disposes of
//!   legacy approval fields as *assertions*; a component with no identity model
//!   that reads them as credentials relocates that High finding rather than
//!   closing it (ADR 0008 §2.2).
//! - does **not** read project contents, and does **not** resolve a job.
//!
//! The test `a_structurally_valid_trigger_from_an_unauthorized_source_is_still_admitted`
//! in `router/tests/gates.rs` asserts that last boundary from the outside. It is
//! the one test in this crate that exists to fail if somebody later makes the
//! router smarter than it is allowed to be.

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
#![allow(clippy::derivable_impls)]

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

pub mod auth;
pub mod bind;
pub mod config;
pub mod error;
/// M7.10's `sd_notify` readiness, so `Type=notify` is truthful.
pub mod notify;
/// M7.5's durable admission queue. Storage only — it decides nothing about
/// retry timing (M7.6), drains nothing (M7.7), delivers nothing (M7.8), and
/// authorizes nothing (§2.2).
///
/// The store is the reason a `202` in [`routes`] is truthful, and its module docs
/// are the specification for every durability claim this crate makes.
pub mod outbox;
/// M7.6 backoff policy and full-jitter delay computation.
pub mod policy;
pub mod routes;
pub mod validate;

/// The contract version this binary was generated against.
///
/// Read from the generated module rather than restated, so a contract bump that
/// forgets to update a hand-written constant cannot compile.
pub const CONTRACT_VERSION: &str = contracts::CONTRACT_VERSION;

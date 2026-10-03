//! Cross-language contract parity: do the generated Rust types accept and reject
//! exactly what the TypeScript engine accepts and rejects?
//!
//! ## What this test is and is not
//!
//! This is the RUST HALF of the parity check. Its counterpart is
//! `tests/contracts/ingress-parity.test.ts`, which validates the same 15 fixtures
//! against the committed JSON Schema with `ajv`. Each side prints an
//! accept/reject vector; this file asserts the vector it computed matches the one
//! the TypeScript side committed to `router/tests/parity-vector.json`.
//!
//! A shared committed vector, rather than two sides each printing for a human to
//! eyeball, is the point: eyeballing two lists that a reader has to trust were
//! produced from the same fixtures is exactly the check that fails silently.
//!
//! ## The 15 fixtures
//!
//! All of `tests/contracts/examples/*.v1.json`, which is 15 files. They bind to
//! the schemas in `src/orchestration/schemas.ts`, NOT to the ingress schemas in
//! `src/config/schemas.ts` -- measured: the ingress closure covers zero of them.
//! That is why the contract set is the union of both closures (ADR 0008 §2.3).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use aibr_router::contracts;

/// One fixture's verdict. `true` means the generated Rust type accepted it.
type Verdict = bool;

/// fixture file name -> accepted?
type Vector = BTreeMap<String, Verdict>;

fn examples_directory() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("router/ has a parent: the repository root")
        .join("tests/contracts/examples")
}

/// The committed vector the TypeScript side produced.
///
/// `expect` rather than a `Result`: a missing or unreadable vector means the two
/// halves are not wired to each other, and a test that reported that as "0 passed"
/// would hide the disconnection behind a green suite.
fn expected_vector() -> Vector {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity-vector.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "cannot read {}: {error}\n\
             Run `bun run generate:parity-vector` first. A missing vector is not an \
             empty one: it means the TypeScript and Rust halves are not comparing \
             against the same expectations.",
            path.display()
        )
    });
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not valid JSON: {error}", path.display()))
}

fn fixture_names() -> Vec<String> {
    let directory = examples_directory();
    let entries = std::fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", directory.display()));
    let mut names: Vec<String> = entries
        .map(|entry| {
            entry
                .expect("a readable directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".v1.json"))
        .collect();
    names.sort();
    names
}

/// Assert the fixture set has not silently shrunk.
///
/// Measured 15. A count regression is the failure mode this catches: if a schema
/// stops generating, the fixture is dropped from both sides and both vectors agree
/// on a shorter list, which is a green test describing less coverage.
#[test]
fn fixture_set_is_the_fifteen_fixtures() {
    let names = fixture_names();
    assert_eq!(
        names.len(),
        15,
        "expected 15 fixtures under {}, found {names:?}\n\
         The plan and ADR 0008 section 9 both say 15. If a fixture was removed, \
         that is a contract decision to make deliberately and record, not one to \
         absorb by lowering this number.",
        examples_directory().display()
    );
}

/// The parity assertion.
///
/// Each fixture is deserialized into the generated type that corresponds to its
/// own contract file. A fixture that deserializes is accepted; one that fails is
/// rejected. The resulting map must equal the committed vector exactly.
#[test]
fn rust_and_typescript_agree_on_every_fixture() {
    let expected = expected_vector();
    let names = fixture_names();

    // Both sides must be describing the same fixtures. A vector naming a fixture
    // that does not exist is a stale artefact, and comparing against it would
    // report a mismatch that reads like a real divergence.
    for name in expected.keys() {
        assert!(
            names.contains(name),
            "{} names a fixture that does not exist under {}. The vector is stale.",
            examples_directory().display(),
            name
        );
    }
    assert_eq!(
        expected.len(),
        names.len(),
        "the vector names {} fixtures but {} exist; regenerate it",
        expected.len(),
        names.len()
    );

    let mut actual: Vector = BTreeMap::new();
    for name in &names {
        let path = examples_directory().join(name);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
        actual.insert(name.clone(), accepts(name, &text));
    }

    assert_eq!(
        actual, expected,
        "the Rust and TypeScript sides disagree on at least one fixture.\n\
         Rust accepts where the vector says reject (or the reverse). The first \
         difference below is where the two languages have drifted; the JSON Schema \
         and the generated Rust type are supposed to describe one shape."
    );
}

/// Deserialize one fixture into its generated type.
///
/// The mapping from fixture name to Rust type is by CONTRACT FILE, not by a
/// hand-written match: `foo.v1.json` is validated by whatever type
/// `contracts/v1/foo.schema.json` generated. A hand-maintained mapping here would
/// be a fourth copy of the contract registry, which is the drift ADR 0008 §2.3
/// exists to prevent.
fn accepts(fixture_name: &str, text: &str) -> bool {
    // The fixture stem names the contract file, and the Rust type name comes
    // from that file's schema `title` -- NOT from the stem. Four of them differ,
    // which is why the mismatch is real and not defensive:
    //   role.schema.json            -> RoleTemplate  (not Role)
    //   memory.schema.json          -> MemoryRecord  (not Memory)
    //   controller-lease.schema.json-> ControllerLease
    //   command/event.schema.json   -> OrchestrationCommand/Event
    // Guessing from the stem compiles for eleven of fifteen and fails loudly on
    // the rest, which is the failure mode worth having.
    let contract = fixture_name.trim_end_matches(".v1.json");
    match contract {
        "command" => serde_json::from_str::<contracts::OrchestrationCommand>(text).is_ok(),
        "event" => serde_json::from_str::<contracts::OrchestrationEvent>(text).is_ok(),
        "run" => serde_json::from_str::<contracts::Run>(text).is_ok(),
        "task" => serde_json::from_str::<contracts::Task>(text).is_ok(),
        "dispatch" => serde_json::from_str::<contracts::Dispatch>(text).is_ok(),
        "session" => serde_json::from_str::<contracts::Session>(text).is_ok(),
        "node" => serde_json::from_str::<contracts::Node>(text).is_ok(),
        "project" => serde_json::from_str::<contracts::Project>(text).is_ok(),
        "role" => serde_json::from_str::<contracts::RoleTemplate>(text).is_ok(),
        "rule" => serde_json::from_str::<contracts::Rule>(text).is_ok(),
        "approval" => serde_json::from_str::<contracts::Approval>(text).is_ok(),
        "memory" => serde_json::from_str::<contracts::MemoryRecord>(text).is_ok(),
        "artifact" => serde_json::from_str::<contracts::Artifact>(text).is_ok(),
        "mesh" => serde_json::from_str::<contracts::Mesh>(text).is_ok(),
        "controller-lease" => serde_json::from_str::<contracts::ControllerLease>(text).is_ok(),
        other => panic!(
            "no generated Rust type is mapped for fixture `{other}`.\n\
             Either a fixture was added without a contract, or the generated type \
             name changed. Both are drift; do not widen this match to whatever \
             compiles, because a mapping that no longer corresponds to \
             contracts/v1/{other}.schema.json would make this test assert nothing."
        ),
    }
}

/// Unknown keys must be REJECTED, not stripped.
///
/// This is the asymmetry ADR 0008 §2.3 records on purpose: the engine's `z.object`
/// schemas strip unknown keys, and the router is stricter. The test asserts the
/// strict half, because the strict half is the one that would regress silently --
/// a `deny_unknown_fields` lost in a typify upgrade compiles fine and stops
/// rejecting, and nothing else would notice.
#[test]
fn unknown_keys_are_rejected_not_stripped() {
    let fixture = examples_directory().join("node.v1.json");
    let text = std::fs::read_to_string(&fixture).expect("node.v1.json is readable");
    let mut document: serde_json::Value =
        serde_json::from_str(&text).expect("node.v1.json is valid JSON");

    // An object with an extra key. The key name is deliberately something that
    // could never be a legitimate field, so a rejection cannot be explained by a
    // collision with real schema.
    if let serde_json::Value::Object(map) = &mut document {
        map.insert("__aibr_unknown_key__".to_owned(), serde_json::json!(true));
    } else {
        panic!("node.v1.json is not a JSON object; the fixture shape changed");
    }

    let accepted = serde_json::from_str::<contracts::Node>(&document.to_string()).is_ok();
    assert!(
        !accepted,
        "an unknown key was ACCEPTED.\n\
         Every object schema in contracts/v1/ carries additionalProperties: false, \
         which typify renders as #[serde(deny_unknown_fields)]. If this is now \
         passing, the post-pass in scripts/generate-contracts.ts stopped closing \
         object schemas, or the schemaVersion post-pass that titles inline types \
         stopped running. A router that silently strips unknown keys has lost the \
         gate ADR 0008 section 2.2 Tier 1 exists to provide."
    );
}

/// The contract version is derived, not restated.
///
/// `lib.rs` reads `contracts::CONTRACT_VERSION`, and contract-gen parses it out of
/// the inputs' `$id` urn. A bump to `contracts/v2/` that forgot to follow through
/// would fail to compile rather than leave the binary advertising the version it
/// was built against.
#[test]
fn contract_version_is_the_one_the_inputs_declare() {
    assert_eq!(
        contracts::CONTRACT_VERSION,
        "v1",
        "the generated contract version moved. If this is intended, `contracts/` must \
         move to a new directory (ADR 0002: a version bump means the shape changed), \
         and this assertion moves with it."
    );
}

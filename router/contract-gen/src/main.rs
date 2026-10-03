//! Step two of the ADR 0008 §2.3 contract chain: `contracts/v1/*.schema.json`
//! -> `router/src/contracts.rs`.
//!
//! Both artefacts are committed, so this writes a file into the source tree. It
//! does so idempotently and refuses to write a byte-different file without
//! saying so, because a silent rewrite would make `git diff --exit-code` look
//! like a pass while the tree actually moved.
//!
//! Usage: `cargo run -p aibr-contract-gen` from the repository root, which is
//! what `bun run generate:contracts` does.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use schemars::schema::RootSchema;
use typify::{TypeSpace, TypeSpaceSettings};

/// Bumped only when the generator's own output shape changes. Recorded in the
/// generated header so a reviewer can tell "the contracts changed" from "the
/// generator changed".
const GENERATOR_REVISION: &str = "1";

fn main() -> ExitCode {
    match run() {
        Ok(summary) => {
            println!("{summary}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("aibr-contract-gen: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<String, String> {
    let repository_root = repository_root()?;
    let contracts_directory = repository_root.join("contracts/v1");
    let destination = repository_root.join("router/src/contracts.rs");

    // `BTreeMap`, not a `Vec`: the generated module's item order follows
    // insertion order, so a directory listing sorted by the filesystem would
    // make the output depend on inode order rather than on the file names.
    let mut inputs: BTreeMap<String, PathBuf> = BTreeMap::new();
    let entries = fs::read_dir(&contracts_directory)
        .map_err(|error| format!("cannot read {}: {error}", contracts_directory.display()))?;
    for entry in entries {
        let path = entry
            .map_err(|error| format!("cannot read an entry of {}: {error}", contracts_directory.display()))?
            .path();
        let is_contract = path.extension().is_some_and(|extension| extension == "json")
            && path.file_name().is_some_and(|name| name.to_string_lossy().ends_with(".schema.json"));
        if is_contract {
            inputs.insert(path.file_name().expect("checked above").to_string_lossy().into_owned(), path);
        }
    }
    if inputs.is_empty() {
        return Err(format!("no *.schema.json under {}", contracts_directory.display()));
    }

    let mut settings = TypeSpaceSettings::default();
    // The generated structs must reject unknown keys. typify emits
    // `#[serde(deny_unknown_fields)]` for a schema carrying
    // `additionalProperties: false`, which the TypeScript post-pass in
    // scripts/generate-contracts.ts guarantees for every object subschema.
    // `UnknownPolicy::Deny` turns an unexpected `x-rust-type` extension into a
    // hard failure: no committed schema may name a crate this workspace does
    // not depend on, because the result would not compile here.
    settings.with_unknown_crates(typify::UnknownPolicy::Deny);

    let mut type_space = TypeSpace::new(&settings);
    let mut generated_names = Vec::new();

    for (file_name, path) in &inputs {
        let file = fs::File::open(path).map_err(|error| format!("cannot open {}: {error}", path.display()))?;
        let root: RootSchema = serde_json::from_reader(file)
            .map_err(|error| format!("cannot parse {} as JSON Schema: {error}", path.display()))?;

        // typify derives a root type's name from `title`, and returns `None`
        // for an untitled root. scripts/generate-contracts.ts writes a title,
        // so a `None` here means the two halves of the chain disagree.
        let type_id = type_space
            .add_root_schema(root)
            .map_err(|error| format!("typify rejected {}: {error}", path.display()))?;
        let type_id = type_id.ok_or_else(|| {
            format!("{} has no `title`; the TypeScript generator and typify disagree on naming", path.display())
        })?;
        // `get_type` is how typify 0.8 exposes a type's name. There is no
        // `TypeSpace::type_name`; a `TypeId` is an index into the space, and
        // only the `Type` it resolves to carries a name.
        let generated_name = type_space
            .get_type(&type_id)
            .map_err(|error| format!("typify could not resolve the type id for {}: {error}", path.display()))?
            .name();
        generated_names.push(format!("{file_name} -> {generated_name}"));
    }

    let body = render(&type_space)?;

    let mut header = String::new();
    header.push_str("// @generated — DO NOT EDIT.\n");
    header.push_str("//\n");
    header.push_str("// Generator: aibr-contract-gen (router/contract-gen/src/main.rs), revision ");
    header.push_str(GENERATOR_REVISION);
    header.push_str(", using typify 0.8.0.\n");
    header.push_str("// Inputs:   contracts/v1/*.schema.json (");
    header.push_str(&inputs.len().to_string());
    header.push_str(" files, in the order listed below)\n");
    header.push_str("//            ^ generated by scripts/generate-contracts.ts from the Zod schemas\n");
    header.push_str("//              in src/config/schemas.ts and src/orchestration/schemas.ts,\n");
    header.push_str("//              which are the single source of truth (ADR 0008 §2.3).\n");
    header.push_str("//\n");
    header.push_str("// Regenerate with:\n");
    header.push_str("//     bun run generate:contracts\n");
    header.push_str("// A hand edit to this file is a build failure, not a review comment: CI runs\n");
    header.push_str("// `git diff --exit-code contracts/ router/src/contracts.rs` after generation.\n");
    header.push_str("//\n");
    header.push_str("// Unknown keys are REJECTED, not stripped: every object schema carries\n");
    header.push_str("// `additionalProperties: false`, which typify renders as\n");
    header.push_str("// `#[serde(deny_unknown_fields)]`. This makes the router strictly stricter\n");
    header.push_str("// than the TypeScript engine, whose `z.object` schemas strip unknown keys. The\n");
    header.push_str("// asymmetry is intentional (ADR 0008 §2.2 Tier 1) and is recorded at ADR 0008\n");
    header.push_str("// §2.3 so it is not later \"fixed\" into symmetry.\n");
    header.push_str("//\n");
    header.push_str("// What these types do NOT enforce, and no consumer may assume they do:\n");
    header.push_str("//   * `.refine()` / `.superRefine()` invariants from the Zod source. JSON\n");
    header.push_str("//     Schema cannot express them and they are absent from the artefacts. The\n");
    header.push_str("//     TypeScript engine remains their sole authority (ADR 0008 §2.2 Tier 2).\n");
    header.push_str("//   * `format`. ajv-core and typify both treat `format` as an annotation and\n");
    header.push_str("//     neither asserts it, so `{ \"type\": \"string\", \"format\": \"uri\" }`\n");
    header.push_str("//     generates a `String`. M7.3 must validate URL syntax explicitly.\n");
    header.push_str("//\n");
    header.push_str("// Type name per input file:\n");
    for line in &generated_names {
        header.push_str("//   ");
        header.push_str(line);
        header.push('\n');
    }
    header.push('\n');

    let rendered = format!("{header}{body}");

    // Writing only on change keeps `cargo` and every editor from touching the
    // file's mtime when nothing moved, so "regenerate" does not look like a
    // modification in `git status`.
    let current = fs::read_to_string(&destination).ok();
    if current.as_deref() == Some(rendered.as_str()) {
        return Ok(format!(
            "aibr-contract-gen: {} inputs -> {} is already up to date",
            inputs.len(),
            destination.display()
        ));
    }
    fs::write(&destination, &rendered).map_err(|error| format!("cannot write {}: {error}", destination.display()))?;
    Ok(format!(
        "aibr-contract-gen: wrote {} types from {} inputs to {}",
        // `iter_types` yields `Type<'_>`, and `Type::name()` returns a `String`
        // by value. It is not a `Result` and not a reference, so neither
        // `.cloned()` nor `.ok()` applies.
        type_space.iter_types().map(|generated| generated.name()).count(),
        inputs.len(),
        destination.display()
    ))
}

/// Render the `TypeSpace` as formatted Rust source.
///
/// `to_stream` returns a `proc_macro2::TokenStream`, which is a token soup, not
/// a parsed module. `syn::parse2` is what turns it into a `syn::File` that can
/// be formatted; iterating the tokens and collecting them as `syn::Item` is not
/// equivalent, because a top-level `Item` is not one token — a struct, say, is a
/// keyword, a name, a brace group and a body.
///
/// `prettyplease` is the same formatter typify's own macro uses, so the committed
/// file matches what `cargo expand` would produce.
fn render(type_space: &TypeSpace) -> Result<String, String> {
    let file: syn::File = syn::parse2(type_space.to_stream())
        .map_err(|error| format!("typify emitted a token stream that is not a Rust module: {error}"))?;
    Ok(prettyplease::unparse(&file))
}

/// Locate the repository root from the manifest directory.
///
/// `CARGO_MANIFEST_DIR` is `<root>/router/contract-gen`, so two levels up is
/// the root. Resolved at run time rather than passed as an argument so
/// `bun run generate:contracts` cannot be invoked from the wrong directory and
/// write `contracts.rs` somewhere untracked.
fn repository_root() -> Result<PathBuf, String> {
    let manifest_directory = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR")
            .ok_or_else(|| "CARGO_MANIFEST_DIR is unset; run this through `cargo run`".to_owned())?,
    );
    let root = manifest_directory
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| format!("cannot derive the repository root from {}", manifest_directory.display()))?;
    if !root.join("contracts/v1").is_dir() {
        return Err(format!(
            "{} does not look like the AIBridge repository root: contracts/v1 is missing",
            root.display()
        ));
    }
    Ok(root.to_path_buf())
}

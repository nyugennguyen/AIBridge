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

/// The contract families that belong to the LOCAL IPC BUS rather than to the
/// admission router.
///
/// WHY THE PARTITION EXISTS, and it is a size bound rather than taste. The
/// router's release binary is gated at 2.25 MiB by
/// `.github/workflows/milestone-7.yml`, and the typify output for these thirteen
/// families is tens of thousands of lines of validation and construction code
/// for messages the router never receives. Compiling them into
/// `router/src/contracts.rs` would push a binary that is ALREADY over its
/// original 2 MiB bound further past it to buy nothing.
///
/// WHY A LIST AND NOT A NAMING CONVENTION. A prefix (`ipc-*.schema.json`) would
/// be self-maintaining, but it would also make the boundary depend on a filename
/// convention nobody is forced to notice. An explicit list makes adding an IPC
/// family a reviewed line, and the two-partition check below turns a file that
/// belongs to neither side into a generation failure rather than a silent
/// omission.
const IPC_CONTRACT_FILES: &[&str] = &[
    "ack.schema.json",
    "control-command.schema.json",
    "job-state.schema.json",
    "job-view.schema.json",
    "pane-view.schema.json",
    "pty-chunk.schema.json",
    "pty-exit.schema.json",
    "server-error.schema.json",
    "server-message.schema.json",
    "state-diff.schema.json",
    "state-snapshot.schema.json",
    "tailscale-status.schema.json",
    "workspace-view.schema.json",
];

fn run() -> Result<String, String> {
    let repository_root = repository_root()?;
    let all = read_contract_inputs(&repository_root.join("contracts/v1"))?;
    let router_inputs = contracts_partition_router(&all)?;
    let ipc_inputs = contracts_partition_ipc(&all)?;
    assert_root_names_disjoint(
        "router admission",
        &router_inputs,
        "local IPC bus",
        &ipc_inputs,
    )?;
    let destinations = [
        (
            "router admission contracts",
            router_inputs,
            repository_root.join("router/src/contracts.rs"),
            "src/config/schemas.ts, src/orchestration/schemas.ts",
        ),
        (
            "local IPC bus contracts",
            ipc_inputs,
            repository_root.join("crates/aibr-ipc/src/contracts.rs"),
            "src/ipc/schemas.ts",
        ),
    ];

    let mut summaries = Vec::new();
    for (label, inputs, destination, sources) in destinations {
        summaries.push(emit_target(label, inputs, &destination, sources)?);
    }
    Ok(summaries.join("\n"))
}

/// Read every `*.schema.json` under `contracts/v1`, keyed by file name.
///
/// `BTreeMap`, not a `Vec`: the generated module's item order follows
/// insertion order, so a directory listing sorted by the filesystem would
/// make the output depend on inode order rather than on the file names.
fn read_contract_inputs(
    contracts_directory: &Path,
) -> Result<BTreeMap<String, PathBuf>, String> {
    let mut inputs: BTreeMap<String, PathBuf> = BTreeMap::new();
    let entries = fs::read_dir(&contracts_directory)
        .map_err(|error| format!("cannot read {}: {error}", contracts_directory.display()))?;
    for entry in entries {
        let path = entry
            .map_err(|error| {
                format!(
                    "cannot read an entry of {}: {error}",
                    contracts_directory.display()
                )
            })?
            .path();
        let is_contract = path
            .extension()
            .is_some_and(|extension| extension == "json")
            && path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(".schema.json"));
        if is_contract {
            inputs.insert(
                path.file_name()
                    .expect("checked above")
                    .to_string_lossy()
                    .into_owned(),
                path,
            );
        }
    }
    if inputs.is_empty() {
        return Err(format!(
            "no *.schema.json under {}",
            contracts_directory.display()
        ));
    }
    Ok(inputs)
}

/// Split the read inputs into the two generated units, refusing a partial split.
///
/// The refusal is the point of the function. A new `contracts/v1/*.schema.json`
/// that is not in `IPC_CONTRACT_FILES` is generated into the ROUTER, where a
/// TUI message family would inflate a size-gated binary; a name in the list that
/// no longer exists on disk is a stale entry that would otherwise sit unnoticed.
/// Both are generation errors, not warnings, because `bun run generate:contracts`
/// is the CI command and this is where it can still fail loudly.
fn contracts_partition(
    inputs: &BTreeMap<String, PathBuf>,
    take: impl Fn(&str) -> bool,
    label: &str,
) -> Result<BTreeMap<String, PathBuf>, String> {
    let selected: BTreeMap<String, PathBuf> = inputs
        .iter()
        .filter(|(name, _)| take(name))
        .map(|(name, path)| (name.clone(), path.clone()))
        .collect();
    if selected.is_empty() {
        return Err(format!("the {label} partition is empty"));
    }
    Ok(selected)
}

fn contracts_partition_router(all: &BTreeMap<String, PathBuf>) -> Result<BTreeMap<String, PathBuf>, String> {
    let claimed = contracts_partition(all, |name| IPC_CONTRACT_FILES.contains(&name.as_ref()), "local IPC bus")?;
    for name in IPC_CONTRACT_FILES {
        if !claimed.contains_key(*name) {
            return Err(format!(
                "IPC_CONTRACT_FILES lists `{name}`, which is not present in contracts/v1; the entry is stale"
            ));
        }
    }
    contracts_partition(all, |name| !IPC_CONTRACT_FILES.contains(&name.as_ref()), "router admission")
}

fn contracts_partition_ipc(all: &BTreeMap<String, PathBuf>) -> Result<BTreeMap<String, PathBuf>, String> {
    contracts_partition(all, |name| IPC_CONTRACT_FILES.contains(&name.as_ref()), "local IPC bus")
}

/// Generate one Rust module from one partition of the contracts.
#[allow(clippy::too_many_arguments)]
fn emit_target(
    label: &str,
    inputs: BTreeMap<String, PathBuf>,
    destination: &Path,
    source_modules: &str,
) -> Result<String, String> {
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
        let file = fs::File::open(path)
            .map_err(|error| format!("cannot open {}: {error}", path.display()))?;
        let root: RootSchema = serde_json::from_reader(file)
            .map_err(|error| format!("cannot parse {} as JSON Schema: {error}", path.display()))?;

        // typify derives a root type's name from `title`, and returns `None`
        // for an untitled root. scripts/generate-contracts.ts writes a title,
        // so a `None` here means the two halves of the chain disagree.
        let type_id = type_space
            .add_root_schema(root)
            .map_err(|error| format!("typify rejected {}: {error}", path.display()))?;
        let type_id = type_id.ok_or_else(|| {
            format!(
                "{} has no `title`; the TypeScript generator and typify disagree on naming",
                path.display()
            )
        })?;
        // `get_type` is how typify 0.8 exposes a type's name. There is no
        // `TypeSpace::type_name`; a `TypeId` is an index into the space, and
        // only the `Type` it resolves to carries a name.
        let generated_name = type_space
            .get_type(&type_id)
            .map_err(|error| {
                format!(
                    "typify could not resolve the type id for {}: {error}",
                    path.display()
                )
            })?
            .name();
        generated_names.push(format!("{file_name} -> {generated_name}"));
    }

    let body = render(&type_space)?;

    // The contract version is derived from the `$id` urn of the inputs, never
    // restated here. `lib.rs` reads `contracts::CONTRACT_VERSION`, so a bump that
    // moved `contracts/v1/` to `v2` without this following would fail to compile
    // rather than leave the binary advertising the version it was built against.
    //
    // Agreement across inputs is checked rather than assumed: two files carrying
    // different `$id` versions is a state a partial directory move produces, and
    // picking either one silently would make the constant a guess.
    let mut version: Option<String> = None;
    for (file_name, path) in &inputs {
        let file = fs::File::open(path)
            .map_err(|error| format!("cannot open {}: {error}", path.display()))?;
        let document: serde_json::Value = serde_json::from_reader(file)
            .map_err(|error| format!("cannot parse {} as JSON: {error}", path.display()))?;
        let id = document
            .get("$id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                format!(
                    "{} has no `$id`; the contract version cannot be derived",
                    path.display()
                )
            })?;
        let found = id
            .strip_prefix("urn:aibridge:contracts:")
            .and_then(|rest| rest.split(':').next())
            .filter(|segment| !segment.is_empty())
            .ok_or_else(|| format!("{} has `$id` `{id}`, which does not start with urn:aibridge:contracts:<version>:", path.display()))?;
        match &version {
            None => version = Some(found.to_owned()),
            Some(expected) if expected != found => {
                return Err(format!(
                    "{} declares contract version `{found}` but {file_name} declares `{expected}`; all inputs must agree",
                    path.display()
                ));
            }
            Some(_) => {}
        }
    }
    let contract_version =
        version.ok_or_else(|| "no contract inputs carried a version".to_owned())?;
    let version_declaration = format!(
        "/// The contract version these types were generated from.\n\
         ///\n\
         /// Emitted by `aibr-contract-gen`, not written by hand: it is parsed from\n\
         /// the `$id` urn of the inputs above, so it cannot drift from the\n\
         /// artefacts it describes.\n\
         pub const CONTRACT_VERSION: &str = \"{}\";\n\n",
        contract_version
    );

    let mut header = String::new();
    header.push_str("// @generated — DO NOT EDIT.\n");
    header.push_str("//\n");
    header.push_str("// Generator: aibr-contract-gen (router/contract-gen/src/main.rs), revision ");
    header.push_str(GENERATOR_REVISION);
    header.push_str(", using typify 0.8.0.\n");
    header.push_str("// Contents: the ");
    header.push_str(label);
    header.push_str(" partition of contracts/v1 (");
    header.push_str(&inputs.len().to_string());
    header.push_str(" files, in the order listed below)\n");
    header.push_str(
        "//            ^ generated by scripts/generate-contracts.ts from the Zod schemas\n",
    );
    header.push_str("//              in ");
    header.push_str(source_modules);
    header.push_str(",\n");
    header.push_str("//              which are the single source of truth (ADR 0008 §2.3).\n");
    header.push_str("//\n");
    header.push_str("// PARTITIONING. `contracts/v1/` is split across several generated units\n");
    header.push_str("// by IPC_CONTRACT_FILES in this generator, so that a crate compiles\n");
    header.push_str("// only the families it actually speaks. Adding a schema there without\n");
    header.push_str("// adding its name to that list is a generation error, not a silent drop.\n");
    header.push_str("//\n");
    header.push_str("// Regenerate with:\n");
    header.push_str("//     bun run generate:contracts\n");
    header.push_str(
        "// A hand edit to this file is a build failure, not a review comment: CI runs\n",
    );
    header.push_str(
        "// `git diff --exit-code contracts/ router/src/contracts.rs crates/aibr-ipc/src/contracts.rs`\n",
    );
    header.push_str("// after generation.\n");
    header.push_str("//\n");
    header.push_str("// Unknown keys are REJECTED, not stripped: every object schema carries\n");
    header.push_str("// `additionalProperties: false`, which typify renders as\n");
    header
        .push_str("// `#[serde(deny_unknown_fields)]`. This makes the router strictly stricter\n");
    header.push_str(
        "// than the TypeScript engine, whose `z.object` schemas strip unknown keys. The\n",
    );
    header.push_str(
        "// asymmetry is intentional (ADR 0008 §2.2 Tier 1) and is recorded at ADR 0008\n",
    );
    header.push_str("// §2.3 so it is not later \"fixed\" into symmetry.\n");
    header.push_str("//\n");
    header.push_str("// What these types do NOT enforce, and no consumer may assume they do:\n");
    header.push_str("//   * `.refine()` / `.superRefine()` invariants from the Zod source. JSON\n");
    header.push_str(
        "//     Schema cannot express them and they are absent from the artefacts. The\n",
    );
    header.push_str(
        "//     TypeScript engine remains their sole authority (ADR 0008 §2.2 Tier 2).\n",
    );
    header.push_str(
        "//   * `format`. ajv-core and typify both treat `format` as an annotation and\n",
    );
    header.push_str(
        "//     neither asserts it, so `{ \"type\": \"string\", \"format\": \"uri\" }`\n",
    );
    header.push_str("//     generates a `String`. M7.3 must validate URL syntax explicitly.\n");
    header.push_str("//\n");
    header.push_str("// Type name per input file:\n");
    for line in &generated_names {
        header.push_str("//   ");
        header.push_str(line);
        header.push('\n');
    }
    header.push('\n');
    header.push_str(&version_declaration);

    // The body lands after the const because `prettyplease` formatted only the
    // types: splicing a declaration in front of already-formatted text keeps both
    // halves valid Rust without re-parsing a 3 MB file to put one item on top.
    let mut rendered = header;
    rendered.push_str(&body);

    // Writing only on change keeps `cargo` and every editor from touching the
    // file's mtime when nothing moved, so "regenerate" does not look like a
    // modification in `git status`.
    let current = fs::read_to_string(&destination).ok();
    if current.as_deref() == Some(rendered.as_str()) {
        return Ok(format!(
            "aibr-contract-gen: {} partition, {} inputs -> {} is already up to date",
            label,
            inputs.len(),
            destination.display()
        ));
    }
    fs::write(&destination, &rendered)
        .map_err(|error| format!("cannot write {}: {error}", destination.display()))?;
    Ok(format!(
        "aibr-contract-gen: {} -> {} types from {} inputs",
        label,
        // `iter_types` yields `Type<'_>`, and `Type::name()` returns a `String`
        // by value. It is not a `Result` and not a reference, so neither
        // `.cloned()` nor `.ok()` applies.
        type_space
            .iter_types()
            .map(|generated| generated.name())
            .count(),
        inputs.len(),
    ))
}

/// Assert that every input partition produced a distinct set of root names.
///
/// WHY THIS EXISTS. `contracts/v1/` holds two independent families that are
/// generated into two different crates, and neither crate's build can see the
/// other's types. A name collision -- say a future `state-diff.schema.json` in
/// the ingress closure and the IPC `state-diff.schema.json` -- would compile
/// cleanly in both units and produce two distinct Rust types with the same name
/// for the same conceptual thing, which is the exact divergence ADR 0008 §2.3
/// exists to prevent and which no test on either side would catch.
///
/// The root names come from each schema's `title`, so this is a check on the
/// committed artefacts rather than on the generator's behaviour.
fn assert_root_names_disjoint(
    first_label: &str,
    first: &BTreeMap<String, PathBuf>,
    second_label: &str,
    second: &BTreeMap<String, PathBuf>,
) -> Result<(), String> {
    let mut first_names = BTreeMap::new();
    for (file_name, path) in first {
        let name = root_type_name(path)?;
        if let Some(previous) = first_names.insert(name.clone(), file_name.clone()) {
            return Err(format!(
                "{file_name} and {previous} both declare the root type `{name}`"
            ));
        }
    }
    for (file_name, path) in second {
        let name = root_type_name(path)?;
        if let Some(previous) = first_names.get(&name) {
            return Err(format!(
                "{file_name} declares the root type `{name}`, which {previous} in the {first_label} partition already declares; the two partitions cannot share a type name"
            ));
        }
        let _ = second_label;
    }
    Ok(())
}

/// The `title` typify will name the generated root type after.
fn root_type_name(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    let document: serde_json::Value = serde_json::from_reader(file)
        .map_err(|error| format!("cannot parse {} as JSON: {error}", path.display()))?;
    document
        .get("title")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            format!(
                "{} has no `title`; the generated type name cannot be determined",
                path.display()
            )
        })
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
    let file: syn::File = syn::parse2(type_space.to_stream()).map_err(|error| {
        format!("typify emitted a token stream that is not a Rust module: {error}")
    })?;
    Ok(prettyplease::unparse(&file))
}

/// Locate the repository root from the manifest directory.
///
/// `CARGO_MANIFEST_DIR` is `<root>/router/contract-gen`, so two levels up is
/// the root. Resolved at run time rather than passed as an argument so
/// `bun run generate:contracts` cannot be invoked from the wrong directory and
/// write `contracts.rs` somewhere untracked.
fn repository_root() -> Result<PathBuf, String> {
    let manifest_directory =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").ok_or_else(|| {
            "CARGO_MANIFEST_DIR is unset; run this through `cargo run`".to_owned()
        })?);
    let root = manifest_directory
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| {
            format!(
                "cannot derive the repository root from {}",
                manifest_directory.display()
            )
        })?;
    if !root.join("contracts/v1").is_dir() {
        return Err(format!(
            "{} does not look like the AIBridge repository root: contracts/v1 is missing",
            root.display()
        ));
    }
    Ok(root.to_path_buf())
}

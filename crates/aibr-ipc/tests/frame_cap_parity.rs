//! The two declarations of the frame cap must agree.
//!
//! `frame::MAX_FRAME_BYTES` is hand-written; `MAX_IPC_FRAME_BYTES` is exported
//! from `src/ipc/schemas.ts` into the generated contract. They are separate
//! because the framing layer must not import the contracts module for one
//! `usize` -- and a mismatch would be a silent interoperability break rather
//! than a compile error: the writer would emit frames the reader refuses, or the
//! reader would accept frames the TypeScript side refuses to produce.
//!
//! This test reads the Zod source. It is a source-reading test rather than a
//! generated-constant comparison because `src/ipc/schemas.ts` is the single
//! source of truth and the generated schema is derived from it; reading the
//! origin catches a divergence the moment either side is edited, including an
//! edit to the Zod file that has not been regenerated.

use std::path::PathBuf;

/// Locate `src/ipc/schemas.ts` relative to the crate manifest.
///
/// `CARGO_MANIFEST_DIR` is `<repo>/crates/aibr-ipc`, so the source is two levels
/// up. Resolved at run time rather than passed in so the test cannot be pointed
/// at a different file by an argument.
fn schema_source() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("src")
        .join("ipc")
        .join("schemas.ts");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()))
}

#[test]
fn the_frame_cap_matches_the_zod_declaration() {
    let source = schema_source();
    let declaration = source
        .lines()
        .find(|line| line.contains("MAX_IPC_FRAME_BYTES ="))
        .unwrap_or_else(|| panic!("src/ipc/schemas.ts does not declare MAX_IPC_FRAME_BYTES"));
    let bytes: usize = declaration
        .split_once('=')
        .expect("the declaration has an `=`")
        .1
        .split("//")
        .next()
        .expect("the declaration has a value")
        .split("*")
        .map(str::trim)
        .filter(|factor| !factor.is_empty())
        .map(|factor| {
            factor.parse::<usize>().unwrap_or_else(|error| {
                panic!("could not parse a byte count from {declaration:?}: {error}")
            })
        })
        .product();

    assert_eq!(
        aibr_ipc::frame::MAX_FRAME_BYTES,
        bytes,
        "the Rust frame cap and MAX_IPC_FRAME_BYTES in src/ipc/schemas.ts disagree; \
         a writer using one and a reader using the other would break the socket silently"
    );
}

#[test]
fn the_socket_path_env_var_matches_the_zod_declaration() {
    let source = schema_source();
    let declaration = source
        .lines()
        .find(|line| line.contains("IPC_SOCKET_PATH_ENV ="))
        .unwrap_or_else(|| panic!("src/ipc/schemas.ts does not declare IPC_SOCKET_PATH_ENV"));
    assert!(
        declaration.contains(aibr_ipc::SOCKET_PATH_ENV),
        "the Rust SOCKET_PATH_ENV and IPC_SOCKET_PATH_ENV in src/ipc/schemas.ts disagree; \
         the Bun worker and the TUI would look for the socket at different paths"
    );
}

#[test]
fn the_default_socket_paths_match_the_zod_declarations() {
    let source = schema_source();
    assert!(
        source.contains(aibr_ipc::DEFAULT_POSIX_SOCKET_PATH),
        "DEFAULT_POSIX_SOCKET_PATH disagrees with src/ipc/schemas.ts"
    );
    assert!(
        source.contains(aibr_ipc::DEFAULT_WINDOWS_PIPE_PATH),
        "DEFAULT_WINDOWS_PIPE_PATH disagrees with src/ipc/schemas.ts"
    );
}

#!/usr/bin/env bash
# scripts/build-matrix.sh
# M7.9 Static build matrix and packaging for aibr-router.
# Builds musl targets (x86_64, aarch64), gnu fallback, and Darwin targets with lipo universal binary.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# ADR 0010 moved the Cargo workspace root to the repository root, so build output
# lands in `${ROOT_DIR}/target` rather than `${ROOT_DIR}/router/target`. Building
# the ROUTER ONLY is deliberate: `cargo build` with no `-p` would also build the
# TUI, which pulls in ratatui and crossterm and roughly triples the build for a
# matrix whose subject is the router's static musl binary and its 2.25 MiB size
# bound (ADR 0008 12).
CARGO_PACKAGE_ARGS=(-p aibr-router)
DIST_DIR="${ROOT_DIR}/dist-bin"

mkdir -p "${DIST_DIR}"

# Determine version from package.json or router/Cargo.toml
# The repo's version, not `router/Cargo.toml`'s: package.json is what `bun pm pack`
# stamps into the published tarball, so a matrix artefact named for the package
# version matches what npm actually receives.
VERSION=$(grep '"version"' "${ROOT_DIR}/package.json" | head -n1 | cut -d'"' -f4)
echo "=== Building aibr-router matrix (v${VERSION}) ==="

# Run from the WORKSPACE ROOT, not `router/`: `--manifest-path router/Cargo.toml`
# would still resolve the workspace correctly, but `cd`-ing into a member makes
# the target directory ambiguous to anyone reading this script later, and the
# destination path below now names the root explicitly.
cd "${ROOT_DIR}"

TARGETS=(
  "x86_64-unknown-linux-musl"
  "aarch64-unknown-linux-musl"
  "x86_64-unknown-linux-gnu"
  "x86_64-apple-darwin"
  "aarch64-apple-darwin"
)

# NOTE ON BINARY SIZE: ADR 0008 2.1 sets a <= 2 MiB per-target bound, and the
# first real musl build MISSED it at 2,222,768 bytes (2.12 MiB) -- over by
# 125,616. The gap is bundled SQLite: M7.1's 558 KiB stub had no database, which
# is exactly the unknown R-M7.1-4 named.
#
# Two reductions were measured and BOTH REJECTED, recorded here so the next person
# does not re-derive them:
#
#   * `SQLITE_OMIT_*` (FTS3/4/5, RTREE, JSON, load_extension, deprecated,
#     progress callback, trace, shared cache, TCL, compile diagnostics). The safe
#     subset bought 19,360 bytes -- 1.2%, against a 125,616 gap -- so it does not
#     reach the bound, and it is not free: `SQLITE_OMIT_JSON` silently broke
#     admission, answering 503 on every write because the store's SQL uses JSON
#     functions. `the_store_is_wal_and_synchronous_full` still PASSED with that
#     flag set, which is the point: the WAL assertion is necessary and not
#     sufficient. A fragile flag set for 1.2% is a bad trade against a budget it
#     does not meet.
#   * `regress` with `default-features = false, features = ["std"]`: 1,645,136
#     bytes, byte-identical to the default. No win.
#
# RESOLUTION (M8.9 / M7-C6): Resolved via formal ADR 0008 §12 amendment.
# The static musl bound is formally amended to <= 2,359,296 bytes (2.25 MiB),
# preserving zero `NEEDED` shared libraries on musl Linux targets and full bundled
# SQLite WAL/JSON1 support without sidecars or dynamic libc dependencies.
export LIBSQLITE3_FLAGS="${LIBSQLITE3_FLAGS:-}"

# Helper to check if zigbuild is available, else fallback to cargo build --target
build_target() {
  local target="$1"
  echo "--- Building target: ${target} ---"

  if command -v cargo-zigbuild >/dev/null 2>&1; then
    cargo zigbuild "${CARGO_PACKAGE_ARGS[@]}" --target "${target}" --release
  elif command -v zig >/dev/null 2>&1 && cargo help zigbuild >/dev/null 2>&1; then
    cargo zigbuild "${CARGO_PACKAGE_ARGS[@]}" --target "${target}" --release
  else
    # standard cargo build if target is installed
    rustup target add "${target}" 2>/dev/null || true
    cargo build "${CARGO_PACKAGE_ARGS[@]}" --target "${target}" --release
  fi

  local src_bin="${ROOT_DIR}/target/${target}/release/aibr-router"
  local dest_bin="${DIST_DIR}/aibr-router-${target}"
  # A missing binary is a FAILURE, not a warning. The previous version printed a
  # warning and returned success, so a target that failed to cross-compile left no
  # artefact and the step went green -- the later readelf step then failed on a
  # file that was never built, which reads as a packaging bug and is really this.
  if [ ! -f "${src_bin}" ]; then
    echo "Error: ${src_bin} was not produced for target ${target}." >&2
    return 1
  fi
  cp "${src_bin}" "${dest_bin}"
  echo "Copied to ${dest_bin}"
}

# If specific targets passed via arguments, build only those; otherwise all supported
REQUESTED_TARGETS=("$@")
if [ ${#REQUESTED_TARGETS[@]} -eq 0 ]; then
  # Default to host target or all if cross-toolchain present
  if [ "$(uname -s)" = "Darwin" ]; then
    # On macOS, build darwin targets and lipo. No `|| true`: a target that cannot
    # be cross-compiled is a fact the caller needs, not something to paper over.
    rustup target add x86_64-apple-darwin aarch64-apple-darwin 2>/dev/null || true
    build_target "x86_64-apple-darwin"
    build_target "aarch64-apple-darwin"
  else
    # On Linux runner
    for target in "${TARGETS[@]}"; do
      build_target "${target}"
    done
  fi
else
  for target in "${REQUESTED_TARGETS[@]}"; do
    build_target "${target}"
  done
fi

# Create universal binary on Darwin if both darwin targets exist
DARWIN_X86="${DIST_DIR}/aibr-router-x86_64-apple-darwin"
DARWIN_ARM="${DIST_DIR}/aibr-router-aarch64-apple-darwin"
DARWIN_UNIVERSAL="${DIST_DIR}/aibr-router-universal-apple-darwin"

if [ -f "${DARWIN_X86}" ] && [ -f "${DARWIN_ARM}" ]; then
  if command -v lipo >/dev/null 2>&1; then
    echo "--- Creating universal Darwin binary with lipo ---"
    lipo -create -output "${DARWIN_UNIVERSAL}" "${DARWIN_X86}" "${DARWIN_ARM}"
    echo "Created ${DARWIN_UNIVERSAL}"
  fi
fi

# Checksum generation
cd "${DIST_DIR}"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum aibr-router-* > SHA256SUMS 2>/dev/null || true
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 aibr-router-* > SHA256SUMS 2>/dev/null || true
fi

echo "=== Build matrix completed in ${DIST_DIR} ==="
ls -lh "${DIST_DIR}"

#!/usr/bin/env bash
# scripts/build-matrix.sh
# M7.9 Static build matrix and packaging for aibr-router.
# Builds musl targets (x86_64, aarch64), gnu fallback, and Darwin targets with lipo universal binary.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROUTER_DIR="${ROOT_DIR}/router"
DIST_DIR="${ROOT_DIR}/dist-bin"

mkdir -p "${DIST_DIR}"

# Determine version from package.json or router/Cargo.toml
VERSION=$(grep '"version"' "${ROOT_DIR}/package.json" | head -n1 | cut -d'"' -f4)
echo "=== Building aibr-router matrix (v${VERSION}) ==="

cd "${ROUTER_DIR}"

TARGETS=(
  "x86_64-unknown-linux-musl"
  "aarch64-unknown-linux-musl"
  "x86_64-unknown-linux-gnu"
  "x86_64-apple-darwin"
  "aarch64-apple-darwin"
)

# Helper to check if zigbuild is available, else fallback to cargo build --target
build_target() {
  local target="$1"
  echo "--- Building target: ${target} ---"

  if command -v cargo-zigbuild >/dev/null 2>&1; then
    cargo zigbuild --target "${target}" --release
  elif command -v zig >/dev/null 2>&1 && cargo help zigbuild >/dev/null 2>&1; then
    cargo zigbuild --target "${target}" --release
  else
    # standard cargo build if target is installed
    rustup target add "${target}" 2>/dev/null || true
    cargo build --target "${target}" --release
  fi

  local src_bin="${ROUTER_DIR}/target/${target}/release/aibr-router"
  local dest_bin="${DIST_DIR}/aibr-router-${target}"
  if [ -f "${src_bin}" ]; then
    cp "${src_bin}" "${dest_bin}"
    echo "Copied to ${dest_bin}"
  else
    echo "Warning: ${src_bin} not found."
  fi
}

# If specific targets passed via arguments, build only those; otherwise all supported
REQUESTED_TARGETS=("$@")
if [ ${#REQUESTED_TARGETS[@]} -eq 0 ]; then
  # Default to host target or all if cross-toolchain present
  if [ "$(uname -s)" = "Darwin" ]; then
    # On macOS, build darwin targets and lipo
    rustup target add x86_64-apple-darwin aarch64-apple-darwin 2>/dev/null || true
    build_target "x86_64-apple-darwin" || true
    build_target "aarch64-apple-darwin" || true
  else
    # On Linux runner
    for target in "${TARGETS[@]}"; do
      build_target "${target}" || true
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

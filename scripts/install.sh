#!/usr/bin/env bash
set -euo pipefail

YES=0
WITH_UNITS=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --with-units) WITH_UNITS=1 ;;
    --without-units) WITH_UNITS=0 ;;
    --help|-h) echo "Usage: install.sh [--yes] [--with-units|--without-units] [--help] [--version]"; echo "  curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash -s -- --yes"; echo ""; echo "  --with-units     install the router and worker supervision units (systemd on"; echo "                   Linux, launchd on macOS). Requires root. Off by default:"; echo "                   installing a unit that starts a network listener is not a"; echo "                   default an installer may pick on someone's behalf."; echo "  --without-units  leave supervision alone (the default)."; echo ""; echo "Environment:"; echo "  AIBRIDGE_ROUTER_BIN     path to an aibr-router binary used to provision the store"; echo "  AIBRIDGE_INGRESS_OUTBOX absolute path of the admission store (ingress_outbox)"; exit 0 ;;
    --version) echo "2.0.0"; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

confirm() {
  if [ "$YES" -eq 1 ]; then return 0; fi
  printf "%s (y/n) " "$1"
  read -r ans
  case "$ans" in y|Y) return 0 ;; *) return 1 ;; esac
}

# --- platform detect (mirrors src/host/preflight.ts detectOs) ---
OS=""
ARCH="$(uname -m)"
UNAME_S="$(uname -s)"
case "$(uname -s)" in
  Darwin*) OS="macos" ;;
  Linux*)
    if [ -f /etc/os-release ]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      # parse ID= field (ID=debian / ID=ubuntu)
      case "${ID:-}" in
        debian) OS="debian" ;;
        ubuntu) OS="ubuntu" ;;
        *) OS="ubuntu" ;; # ubuntu superset for apt commands
      esac
    else
      OS="ubuntu"
    fi
    ;;
  *) echo "Error: Unsupported platform: $UNAME_S" >&2; exit 1 ;;
esac

echo "Detected OS: $OS ($ARCH)"

# --- prereq check (mirrors src/host/preflight.ts checkPrereqs) ---
has_cmd() { command -v "$1" >/dev/null 2>&1; }

install_cmd_for() {
  local tool="$1"
  case "$OS:$tool" in
    macos:tmux) echo "brew install tmux" ;;
    macos:tailscale) echo "brew install tailscale" ;;
    debian:tmux|ubuntu:tmux) echo "apt-get install -y tmux" ;;
    debian:tailscale|ubuntu:tailscale) echo "tailscale install-from-source --confirm --prefix=/usr/local" ;;
    *) echo "" ;;
  esac
}

check_prereqs() {
  # opencode manual fallback is intentional — no auto-install for opencode
  for tool in tmux opencode tailscale; do
    if has_cmd "$tool"; then
      echo "✓ $tool installed"
    else
      cmd="$(install_cmd_for "$tool")"
      if [ -n "$cmd" ]; then
        echo "✗ $tool missing — install with: $cmd"
      else
        echo "✗ $tool missing — install manually: bun install -g opencode-ai (see https://opencode.ai)"
      fi
    fi
  done
}

# prompt confirm helper — read install tmux with confirmation gating
install_missing_prereqs() {
  if ! has_cmd tmux; then
    if confirm "Install tmux? Run: $(install_cmd_for tmux)"; then
      if [ "$OS" = "macos" ]; then brew install tmux; else sudo apt-get install -y tmux; fi
    fi
  fi
  if ! has_cmd tailscale; then
    if confirm "Install tailscale? Run: $(install_cmd_for tailscale)"; then
      if [ "$OS" = "macos" ]; then brew install tailscale; else sudo apt-get install -y tailscale || tailscale install-from-source --confirm --prefix=/usr/local; fi
    fi
  fi
}

# --- bun check (bun >=1.3.0 required, mirrors package.json engines) ---
ensure_bun() {
  if has_cmd bun; then
    BUN_VER="$(bun --version 2>/dev/null || echo 0.0.0)"
    echo "✓ bun $BUN_VER"
    # simple version check: require 1.3.x
    MAJOR="$(echo "$BUN_VER" | cut -d. -f1)"
    MINOR="$(echo "$BUN_VER" | cut -d. -f2)"
    if [ "$MAJOR" -lt 1 ] || { [ "$MAJOR" -eq 1 ] && [ "${MINOR:-0}" -lt 3 ]; }; then
      echo "Error: bun >=1.3.0 required, found $BUN_VER" >&2; exit 1
    fi
  else
    echo "✗ bun missing — install from https://bun.sh"
    printf "Install bun now? (y/n) "
    read -r ans
    case "$ans" in
      y|Y) curl -fsSL https://bun.sh/install | bash ;;
      *) echo "Aborted: bun is required" >&2; exit 1 ;;
    esac
    export PATH="$HOME/.bun/bin:$PATH"
  fi
}

install_aibridge() {
  # bun install -g @nyugennguyen/aibridge
  VER="${AIBRIDGE_VERSION:-latest}"
  PKG="@nyugennguyen/aibridge"
  if [ "$VER" != "latest" ]; then PKG="${PKG}@${VER}"; fi
  echo "Installing $PKG via bun..."
  bun install -g "$PKG"
  if ! command -v aibr >/dev/null 2>&1; then
    BIN_DIR="$(bun pm bin -g 2>/dev/null || echo "$HOME/.bun/bin")"
    echo "Add to PATH: export PATH=\"$BIN_DIR:\$PATH\" (add to ~/.bashrc or ~/.zshrc)"
  fi
  aibr --version || true
  install_router_binary
}
find_router_bin() {
  # No download URL is constructed here, and that is deliberate rather than
  # pending: no router artifact has been published, so any release-asset URL
  # would be a 404 that looks like a network failure, on every install, forever.
  # A locally built binary is found instead, and its absence is reported as an
  # instruction rather than papered over.
  if [ -n "${AIBRIDGE_ROUTER_BIN:-}" ] && [ -x "$AIBRIDGE_ROUTER_BIN" ]; then
    echo "$AIBRIDGE_ROUTER_BIN"
    return 0
  fi
  if has_cmd aibr-router; then
    command -v aibr-router
    return 0
  fi
  local bin_dir
  bin_dir="$(bun pm bin -g 2>/dev/null || echo "$HOME/.bun/bin")"
  if [ -x "${bin_dir}/aibr-router" ]; then
    echo "${bin_dir}/aibr-router"
    return 0
  fi
  return 1
}

install_router_binary() {
  local bin
  if ! bin="$(find_router_bin)"; then
    echo "⚠ aibr-router not found — the polyglot ingress router is not installed."
    echo "  Build it from a checkout (no Rust toolchain needed on the serving host once built):"
    echo "    cargo build --release --manifest-path router/Cargo.toml"
    echo "    # or, for the static Linux targets:  bash scripts/build-matrix.sh x86_64-unknown-linux-musl"
    echo "    install -m 0755 router/target/release/aibr-router /usr/local/bin/"
    echo "  Then re-run with AIBRIDGE_ROUTER_BIN=/usr/local/bin/aibr-router to provision the store."
    return 0
  fi
  echo "✓ aibr-router at $bin"
  provision_ingress_store "$bin"
}

provision_ingress_store() {
  local bin="${1:-}"
  if [ -z "$bin" ]; then
    echo "⚠ no aibr-router binary: skipping admission store provisioning."
    echo "  The router refuses to start without a provisioned store (exit 78), so run:"
    echo "    AIBRIDGE_INGRESS_OUTBOX=/absolute/path/ingress_outbox aibr-router --init-store"
    return 0
  fi
  if [ -z "${AIBRIDGE_INGRESS_OUTBOX:-}" ]; then
    echo "⚠ AIBRIDGE_INGRESS_OUTBOX is unset: skipping admission store provisioning."
    echo "  Set it to an absolute path and re-run, or provision by hand with:"
    echo "    AIBRIDGE_INGRESS_OUTBOX=/absolute/path/ingress_outbox aibr-router --init-store"
    return 0
  fi

  echo "Provisioning admission store at $AIBRIDGE_INGRESS_OUTBOX ..."
  local status=0
  "$bin" --init-store || status=$?
  if [ "$status" -ne 0 ]; then
    # A refusal here is information, not a nuisance: exit 78 means the path is not
    # a store this build speaks, and the units would refuse to start for the same
    # reason on every boot. Reported rather than swallowed.
    echo "⚠ aibr-router --init-store exited $status; the store was NOT provisioned." >&2
    return 0
  fi
  echo "✓ admission store ready"
}

install_supervision_units() {
  if [ "$WITH_UNITS" -eq 0 ]; then
    echo "Skipping supervision units (pass --with-units to install them)."
    return 0
  fi
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo "Error: --with-units needs root (it writes /etc/systemd/system and /Library/LaunchDaemons)." >&2
    return 1
  fi

  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  if [ "$OS" = "macos" ]; then
    install -m 0755 "$repo_root/packaging/launchd/aibr-router.sh" /usr/local/bin/aibr-router.sh
    install -m 0755 "$repo_root/packaging/launchd/aibr-worker.sh" /usr/local/bin/aibr-worker.sh
    install -m 0644 "$repo_root/packaging/launchd/com.aibridge.router.plist" /Library/LaunchDaemons/com.aibridge.router.plist
    install -m 0644 "$repo_root/packaging/launchd/com.aibridge.worker.plist" /Library/LaunchDaemons/com.aibridge.worker.plist
    launchctl bootstrap system /Library/LaunchDaemons/com.aibridge.router.plist 2>/dev/null || true
    launchctl bootstrap system /Library/LaunchDaemons/com.aibridge.worker.plist 2>/dev/null || true
    echo "✓ launchd daemons installed"
  else
    install -m 0644 "$repo_root/packaging/systemd/aibr-router.service" /etc/systemd/system/aibr-router.service
    install -m 0644 "$repo_root/packaging/systemd/aibr-worker.service" /etc/systemd/system/aibr-worker.service
    systemctl daemon-reload
    systemctl enable aibr-router.service aibr-worker.service
    echo "✓ systemd units enabled (not started: they need /etc/aibridge/router.env)"
  fi

  echo ""
  echo "Still yours to do by hand:"
  echo "  1. Create /etc/aibridge/router.env (mode 0600) with:"
  echo "       AIBRIDGE_CONFIG=/absolute/path/config.json"
  echo "       AIBRIDGE_BEARER_TOKEN=<the shared secret>"
  echo "       AIBRIDGE_INGRESS_OUTBOX=/absolute/path/ingress_outbox"
  echo "     AIBRIDGE_WORKER_PROFILE is required by the worker unit only."
  echo "  2. systemctl start aibr-router aibr-worker   (or: sudo launchctl kickstart -k system/com.aibridge.router)"
}

verify_tailscale() {
  if ! has_cmd tailscale; then
    echo "⚠ tailscale not installed — install with: $(install_cmd_for tailscale)"
    return 0
  fi
  if ! tailscale status >/dev/null 2>&1; then
    echo "⚠ Tailscale not active — run: sudo tailscale up (BackendState not Running)" >&2
  else
    echo "✓ tailscale status ok"
    tailscale ip -4 2>/dev/null | head -n1 | xargs -I{} echo "  Tailscale IP: {}"
  fi
}

main() {
  echo "AIBridge installer — https://github.com/nyugennguyen/AIBridge"
  check_prereqs
  ensure_bun
  verify_tailscale
  install_aibridge
  install_supervision_units
  echo ""
  echo "✓ Installed. Next:"
  echo "  aibr setup --profile <name>   # interactive host setup"
  echo "  aibr start --profile <name>   # start tmux session"
  echo "  aibr status --profile <name>  # verify bridge health"
  echo ""
  echo "Bridge binds Tailscale-only (never public Internet). opencode on 127.0.0.1 only."
  echo "Private network via Tailscale — no public exposure."
}
main
